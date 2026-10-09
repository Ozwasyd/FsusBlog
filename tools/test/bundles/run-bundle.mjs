#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const {verifyProductionBuildReceipt} = await import(new URL('../../ci/production-build-artifacts.mjs', import.meta.url));
const {productionZkRequested} = await import(new URL('../../security/comment-privacy-build-contract.mjs', import.meta.url));
const {createArtifactDigestTable} = await import(new URL('../../test-matrix/artifact-digest-table.mjs', import.meta.url));
const {createAsyncLogPipeline} = await import(new URL('../../test-matrix/async-log-pipeline.mjs', import.meta.url));
const {resolveCommandGroup} = await import(new URL('../../test-matrix/command-groups.mjs', import.meta.url));
const {projectEvidence} = await import(new URL('../../test-matrix/evidence-projection.mjs', import.meta.url));
const {publishFrontendBuildTerminalMarker, validateFrontendBuildStageReceiptBinding, validateFrontendBuildStageReceiptIdentity} = await import(new URL('../../test-matrix/frontend-build-ready-marker.mjs', import.meta.url));
const {writeIntegrityProofProducer} = await import(new URL('../../test-matrix/integrity-proof-producer.mjs', import.meta.url));
const {artifactSubstitutionBindingDigest, matrixGeneratedRuntimePaths, resolveArtifactSubstitutions, resolveFrontendVitestAdmissionFloor, performanceMixedWindowFloorMs, validatePerformanceDeadlineEvidence} = await import(new URL('../../test-matrix/local-profile.mjs', import.meta.url));
const {parseMatrix} = await import(new URL('../../test-matrix/parse-matrix.mjs', import.meta.url));
const {prepareProductionRuntimeLayout, productionBuildEnvironment, productionBuildLayoutDigest, productionDotnetArtifacts, productionRuntimeEnvironment, resolveProductionBuildLayout} = await import(new URL('../../test-matrix/production-build-layout.mjs', import.meta.url));
const {assertProductionFreshBundleProducerWiring, captureProductionFreshOutputInventory, isProductionFreshExpectedLifecycleRemoval, productionFreshGovernanceOutputs, productionFreshProducerInventory, verifyProducerOutputDelta} = await import(new URL('../../test-matrix/production-fresh-run-bound-outputs.mjs', import.meta.url));
const {resolveCgroupLimits} = await import(new URL('../../test-matrix/production-resource-enforcement.mjs', import.meta.url));
const {consumeResetReceiptsForStep, resetPostconditionReceiptFile, resetReceiptsProducedByStep, resolveRuntimeResetContext} = await import(new URL('../../test-matrix/reset-postcondition-verifier.mjs', import.meta.url));
const {consumeResidentLeaseHandoffFile, productionResidentServiceIds, readResidentLeaseDocument, validateResidentLeaseInventory} = await import(new URL('../../test-matrix/resident-resource-leases.mjs', import.meta.url));
const {createLinuxProcessTreeCollector, createWaitLedger, gnuTimeFormat, parseGnuTimeReport, resolveResourceSampleIntervalMs} = await import(new URL('../../test-matrix/resource-utilization.mjs', import.meta.url));
const {publishRunBoundMarker, readRunBoundMarker, waitForRunBoundMarker} = await import(new URL('../../test-matrix/run-bound-marker.mjs', import.meta.url));
const {readSchedulerProducerTerminalFailure} = await import(new URL('../../test-matrix/scheduler-run-owner.mjs', import.meta.url));
const {assertRuntimeAuthorityUnchanged, loadRuntimeStateAuthority} = await import(new URL('../../test-runtime/catalog.mjs', import.meta.url));
const {createProductionBoundaryCollector, stepMutatesRuntimeState} = await import(new URL('../../test-runtime/production-boundary-collector.mjs', import.meta.url));
const {validateRuntimeExecutionSessionReceipt} = await import(new URL('../../test-runtime/runtime-execution-session.mjs', import.meta.url));
const {orderStepsByPlan, runtimeStepCatalogDigest, validateRuntimeSchedulePlan} = await import(new URL('../../test-runtime/schedule-plan.mjs', import.meta.url));
const {createStateConflictPolicy} = await import(new URL('../../test-runtime/state-conflict.mjs', import.meta.url));
const {backendTopologyDefaults} = await import(new URL('../backend-production-topology.mjs', import.meta.url));
const {assertCorrectnessAttemptExecutionOwner, validateCorrectnessAttemptMigration} = await import(new URL('../correctness-attempt-migration.mjs', import.meta.url));
const {buildLocalStaticManifest, planLocalStaticCommands} = await import(new URL('../local-static-governance.mjs', import.meta.url));
const {readMeasurementNoiseAuthoritySequence, validateMeasurementNoiseReceipt} = await import(new URL('../measurement-noise-envelope.mjs', import.meta.url));
const {publishMigrationBuildReady} = await import(new URL('../migration-build-binding.mjs', import.meta.url));
const {migrationAssemblyPendingPaths} = await import(new URL('../../db/generate-migration-assembly-receipt.mjs', import.meta.url));
const {migrationExecutionPaths, readMigrationExecution} = await import(new URL('../run-migration-tests.mjs', import.meta.url));
const {validateShardSummaryArtifacts} = await import(new URL('../run-backend-production-shards.mjs', import.meta.url));

import {
    buildSettledPhaseJoinEvidence,
    executeWeightedStepDag,
    performanceSteps,
    resolveBundleRuntimeCapacity,
    resolveMachineExecutionTimeoutMs,
    resolveStepRuntimeCapacity,
    runtimeSteps,
    StepTerminalError
} from './bundle-steps.mjs';
import { wrapTaskScopedMeasurementCommand } from './measurement-step-command.mjs';
import { readRuntimeEnvironment } from './runtime-environment.mjs';
import { writeBundleSummaryAtomically } from './terminal-summary.mjs';


const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const profileId = process.env.FSUSBLOG_LOCAL_PROFILE || 'production';
const bundleId = process.argv[2];
const finalizeExisting = process.argv.includes('--finalize-existing');
const matrix = parseMatrix(fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'));
const profile = matrix.localProfiles?.[profileId];
const bundle = profile?.bundles?.find((entry) => entry.id === bundleId);
const runtimeStateAuthority = bundleId === 'runtime-browser'
    ? loadRuntimeStateAuthority()
    : null;
const runtimeStateConflictPolicy = runtimeStateAuthority
    ? createStateConflictPolicy(runtimeStateAuthority, {
      assertCurrent: () => assertRuntimeAuthorityUnchanged(runtimeStateAuthority)
    })
    : null;
const matrixTiers = new Map(matrix.tiers.map((tier) => [tier.id, tier]));
const productionFreshOutputRoot = String(process.env.FSUSBLOG_PRODUCTION_FRESH_OUTPUT_ROOT ?? '').trim();
const runOutputRoot = productionFreshOutputRoot ? path.resolve(productionFreshOutputRoot) : null;
const productionFreshLayout = runOutputRoot
    ? {
      repositoryRoot: root,
      runId: String(process.env.FSUSBLOG_TEST_RUN_ID ?? ''),
      attemptId: String(process.env.FSUSBLOG_PRODUCTION_FRESH_ATTEMPT_ID ?? ''),
      runOutputRoot: path.resolve(runOutputRoot, '..', '..'),
      outputRoot: runOutputRoot,
      relativeOutputRoot: path.relative(root, runOutputRoot).replaceAll(path.sep, '/')
    }
    : null;

function outputDirectory(partition, ...segments)
{
    if (runOutputRoot)
    {
        return path.join(runOutputRoot, partition, ...segments);
    }
    return null;
}

function prepareRuntimeOrderSessionLayout()
{
    const sessionRoot = path.resolve(String(process.env.FSUSBLOG_RUNTIME_ORDER_SESSION_ROOT ?? ''));
    if (!runtimeOrderResultFile || !sessionRoot
      || !sessionRoot.startsWith(`${root}${path.sep}`))
    {
        throw new Error('runtime-order mutable layout requires a repository-contained session root');
    }
    const runtimeRoot = path.join(sessionRoot, 'mutable', 'runtime-layout');
    const runtimeFrontendDist = path.join(runtimeRoot, 'frontend', 'dist');
    const runtimeBackendWebRoot = path.join(runtimeRoot, 'backend', 'wwwroot');
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(runtimeFrontendDist), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.dirname(runtimeBackendWebRoot), { recursive: true, mode: 0o700 });
    fs.cpSync(productionBuildLayout.frontendDist, runtimeFrontendDist, {
        recursive: true,
        force: true,
        preserveTimestamps: true
    });
    fs.cpSync(productionBuildLayout.backendWebRoot, runtimeBackendWebRoot, {
        recursive: true,
        force: true,
        preserveTimestamps: true
    });
    return {
        runtimeRoot,
        runtimeFrontendDist,
        runtimeBackendWebRoot,
        environment: {
            FSUSBLOG_FRONTEND_DIST_ROOT: runtimeFrontendDist,
            FSUSBLOG_BACKEND_WEBROOT: runtimeBackendWebRoot,
            FSUSBLOG_WEB_ROOT: runtimeBackendWebRoot,
            FSUSBLOG_RETENTION_WEBROOT_DIR: runtimeBackendWebRoot,
            ASPNETCORE_WEBROOT: runtimeBackendWebRoot
        }
    };
}

function bundleDirectory(...segments)
{
    return outputDirectory('bundles', bundleId || 'unknown', ...segments)
    ?? path.join(root, `.tmp/local-${profileId}`, bundleId || 'unknown', ...segments);
}

function reportDirectory(...segments)
{
    return outputDirectory('reports', ...segments)
    ?? path.join(root, '.tmp/test-results', ...segments);
}

function backendTrxDirectory(...segments)
{
    const configured = String(process.env.FSUSBLOG_BACKEND_TRX_DIR ?? '').trim();
    return configured ? path.join(path.resolve(configured), ...segments) : reportDirectory('backend', ...segments);
}

function coverageDirectory(...segments)
{
    return outputDirectory('coverage', ...segments)
    ?? path.join(root, '.tmp/coverage', ...segments);
}

function releaseEvidenceFile(...segments)
{
    return outputDirectory('release-evidence', ...segments)
    ?? path.join(root, '.tmp/release-evidence', ...segments);
}

function physicalArtifactPath(canonicalPath)
{
    const normalized = String(canonicalPath).replaceAll('\\', '/');
    const mappings = [
        ['.tmp/frontend/', process.env.FSUSBLOG_FRONTEND_OUTPUT_ROOT],
        ['.tmp/security/', process.env.FSUSBLOG_SECURITY_OUTPUT_ROOT],
        ['.tmp/perf/', process.env.FSUSBLOG_PERFORMANCE_OUTPUT_ROOT],
        ['.tmp/scale/', process.env.FSUSBLOG_DATA_SCALE_ROOT],
        ['.tmp/ux/', process.env.FSUSBLOG_UX_OUTPUT_ROOT],
        ['.tmp/physical-execution-projections/', process.env.FSUSBLOG_PHYSICAL_EXECUTION_PROJECTION_DIR],
        ['.tmp/docs/', process.env.FSUSBLOG_DOCS_EVIDENCE_DIR],
        ['.tmp/test-asset-audit/', process.env.FSUSBLOG_TEST_ASSET_AUDIT_DIR],
        ['.tmp/test-governance/', process.env.FSUSBLOG_TEST_GOVERNANCE_DIR]
    ];
    for (const [prefix, configuredRoot] of mappings)
    {
        const rootPath = prefix.slice(0, -1);
        if (configuredRoot && (normalized === rootPath || normalized.startsWith(prefix)))
        {
            return normalized === rootPath
                ? path.resolve(configuredRoot)
                : path.join(configuredRoot, normalized.slice(prefix.length));
        }
    }
    return path.isAbsolute(canonicalPath) ? canonicalPath : path.join(root, canonicalPath);
}

function perceptionRuntimeEvidenceFile()
{
    return String(process.env.FSUSBLOG_PERCEPTION_RUNTIME_EVIDENCE_FILE ?? '').trim()
    || path.join(root, '.tmp/security/perception-v2-e2e-runtime.json');
}

function perceptionMatrixSummaryFile()
{
    return String(process.env.FSUSBLOG_PERCEPTION_MATRIX_SUMMARY_FILE ?? '').trim()
    || path.join(root, '.tmp/security/perception-v2-test-matrix.json');
}

function perceptionReleaseEvidenceFile()
{
    return String(process.env.FSUSBLOG_PERCEPTION_RELEASE_EVIDENCE_FILE ?? '').trim()
    || releaseEvidenceFile('perception-v2-release-evidence.json');
}

const outDir = bundleDirectory();
const summaryFile = path.join(outDir, 'summary.json');
const logDir = path.join(outDir, 'steps');

function measurementAuthorityRootFor(stepId)
{
    return path.join(logDir, `${stepId}.measurement-noise-authority`);
}

function measurementAuthorityManifestRootFor(stepId)
{
    if (!productionFreshLayout)
    {
        return `${measurementAuthorityRootFor(stepId)}.manifest`;
    }
    return path.join(
        productionFreshLayout.runOutputRoot,
        'runtime',
        'measurement-noise-authority-manifests',
        bundleId,
        stepId
    );
}

function priorMeasurementAuthorityRootsFor(stepId)
{
    if (!productionFreshLayout)
    {
        return [];
    }
    const attemptsRoot = path.join(productionFreshLayout.runOutputRoot, 'attempts');
    if (!fs.existsSync(attemptsRoot))
    {
        return [];
    }
    return fs.readdirSync(attemptsRoot)
        .filter((attemptId) =>
            /^attempt-\d{4}$/u.test(attemptId)
      && attemptId < productionFreshLayout.attemptId)
        .sort()
        .map((attemptId) => path.join(
            attemptsRoot,
            attemptId,
            'bundles',
            bundleId,
            'steps',
            `${stepId}.measurement-noise-authority`
        ));
}

const startedAt = Date.now();
const productionBuildLayout = resolveProductionBuildLayout({ root });
if (path.resolve(process.env.FSUSBLOG_PRODUCTION_BUILD_ROOT ?? '') !== productionBuildLayout.runRoot)
{
    throw new Error('physical bundle requires the current run-bound production build root');
}
Object.assign(process.env, productionBuildEnvironment(productionBuildLayout, process.env));
const { createFrontendBuildStages } = await import(new URL('../../frontend/build.mjs', import.meta.url));
const dotnetArtifacts = productionDotnetArtifacts(productionBuildLayout);
const backendTestDll = dotnetArtifacts.testDll;
const migrationTestDll = dotnetArtifacts.migrationTestDll;
const xunitAdapterDll = dotnetArtifacts.xunitAdapterDll;
const benchmarkDll = dotnetArtifacts.benchmarkDll;
const backendServerDll = dotnetArtifacts.serverDll;
const frontendDistRoot = productionBuildLayout.frontendDist;
const frontendWasmRoot = productionBuildLayout.frontendWasm;
const backendWebRoot = productionBuildLayout.backendWebRoot;
const activeStepChildren = new Map();
const stepExecutionResults = new Map();
const stepDeclarations = new Map();
const producerBeforeInventories = new Map();
const producerAfterInventories = new Map();
const stepResourceMetrics = new Map();
const stepEffectiveLimits = new Map();
const waitLedger = createWaitLedger();
let shutdownPromise = null;
const shutdownController = new AbortController();
let runtimeChildEnvironment = {};
const productionRuntimeChildEnvironment = productionRuntimeEnvironment(productionBuildLayout, {});
let performanceDeadlineEvidence = null;
let finalizedResourceUtilization = null;
let frontendPerfAdmissionEvidence = null;
let schedulerTerminalReceipts = {};
let runtimeScheduleExecution = null;
let runtimeScheduleControl = null;
const runtimeOrderResultFile = String(process.env.FSUSBLOG_RUNTIME_ORDER_RESULT_FILE ?? '').trim();
const runtimeOrderBoundaryCollector = bundleId === 'runtime-browser' && runtimeOrderResultFile
    ? await createProductionBoundaryCollector()
    : null;

if (!bundleId || !bundle)
{
    throw new Error(`unknown ${profileId} bundle: ${String(bundleId)}`);
}
const artifactDigestTable = createArtifactDigestTable({
    root,
    file: process.env.FSUSBLOG_ARTIFACT_DIGEST_TABLE,
    runId: schedulerRunId(),
    sourceState: {
        commit: process.env.FSUSBLOG_TEST_SOURCE_COMMIT,
        worktreeFingerprint: process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT
    }
});
if (!finalizeExisting)
{
    fs.rmSync(outDir, { recursive: true, force: true });
}
fs.mkdirSync(logDir, { recursive: true });

const memberEvidence = new Map(bundle.members.map((tierId) => [tierId, {
    status: 'success',
    durationMs: 0,
    testIds: [],
    artifactDigests: {},
    artifactRefs: {}
}]));

async function observeWait(ownerId, state, operation)
{
    waitLedger.observe(ownerId, state);
    try
    {
        return await operation();
    }
    finally
    {
        waitLedger.observe(ownerId, null);
    }
}

function shellQuote(value)
{
    return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function signalProcessGroup(child, signal)
{
    if (process.platform === 'win32')
    {
        if (child.exitCode === null && child.signalCode === null)
        {
            child.kill(signal);
        }
        return;
    }
    try
    {
        process.kill(-child.pid, signal);
    }
    catch (error)
    {
        if (error.code !== 'ESRCH' && child.exitCode === null && child.signalCode === null)
        {
            child.kill(signal);
        }
    }
}

function processGroupIsAlive(child)
{
    if (process.platform === 'win32')
    {
        return child.exitCode === null && child.signalCode === null;
    }
    try
    {
        process.kill(-child.pid, 0);
        return true;
    }
    catch (error)
    {
        return error.code === 'EPERM';
    }
}

async function waitForProcessGroupExit(child, waitMs)
{
    const deadline = Date.now() + waitMs;
    const pollMs = Math.max(10, Math.ceil(waitMs / 20));
    while (processGroupIsAlive(child) && Date.now() < deadline)
    {
        await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, deadline - Date.now())));
    }
    return !processGroupIsAlive(child);
}

async function terminateProcessGroup(child, graceMs)
{
    signalProcessGroup(child, 'SIGTERM');
    if (await waitForProcessGroupExit(child, graceMs))
    {
        return;
    }
    signalProcessGroup(child, 'SIGKILL');
    await waitForProcessGroupExit(child, graceMs);
}

function closeChildPipes(child)
{
    for (const stream of [child.stdin, child.stdout, child.stderr])
    {
        stream?.destroy();
    }
}

function installShutdownForwarding()
{
    for (const [signal, exitCode] of [['SIGTERM', 143], ['SIGINT', 130]])
    {
        process.once(signal, () =>
        {
            if (shutdownPromise)
            {
                return;
            }
            shutdownController.abort(new Error(`bundle cancelled by ${signal}`));
            if (bundleId === 'build-static')
            {
                publishFrontendBuildTerminal('cancelled', signal);
            }
            shutdownPromise = Promise.all([...activeStepChildren.entries()].map(async ([child, record]) =>
            {
                await terminateProcessGroup(child, record.terminationGraceMs);
                closeChildPipes(child);
                await record.logPipeline?.close({
                    complete: false,
                    truncationReason: `bundle-${signal.toLowerCase()}`
                });
            })).then(() => new Promise((resolve) => setImmediate(resolve))).finally(() =>
            {
                try
                {
                    finalizeBundleResourceUtilization('partial', new Error(`bundle cancelled by ${signal}`));
                }
                catch
                {
                    // The primary cancellation path retains the process signal authority.
                }
                process.exit(exitCode);
            });
        });
    }
}

installShutdownForwarding();

function relative(file)
{
    return path.relative(root, file).replaceAll(path.sep, '/');
}

function fileContentDigest(file)
{
    return `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function writeJsonAtomic(file, value)
{
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.next-${process.pid}-${randomUUID()}`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(temporary, file);
}

function schedulerRunId()
{
    const runId = String(process.env.FSUSBLOG_TEST_RUN_ID ?? '').trim();
    if (!runId)
    {
        throw new Error('FSUSBLOG_TEST_RUN_ID is required for run-bound bundle coordination');
    }
    return runId;
}

function digestArtifacts(declarations, step)
{
    return artifactDigestTable.digestDeclarations(declarations, {
        env: process.env,
        producer: { bundle: bundleId, step }
    });
}

function buildLayoutBinding()
{
    return {
        runId: schedulerRunId(),
        manifestPath: relative(productionBuildLayout.manifestFile),
        manifestDigest: productionBuildLayoutDigest(productionBuildLayout),
        sourceCommit: process.env.FSUSBLOG_TEST_SOURCE_COMMIT ?? null,
        sourceFingerprint: process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT ?? null
    };
}

function markerHasCurrentBuildLayout(marker)
{
    const expected = buildLayoutBinding();
    return marker?.buildLayout?.runId === expected.runId
    && marker?.buildLayout?.manifestPath === expected.manifestPath
    && marker?.buildLayout?.manifestDigest === expected.manifestDigest
    && marker?.buildLayout?.sourceCommit === expected.sourceCommit
    && marker?.buildLayout?.sourceFingerprint === expected.sourceFingerprint;
}

function backendBuildReadyFile(runId = schedulerRunId())
{
    return path.join(root, '.tmp/test-runs', runId, 'backend-build-ready.json');
}

function benchmarkBuildReadyFile(runId = schedulerRunId())
{
    return path.join(root, '.tmp/test-runs', runId, 'benchmark-build-ready.json');
}

function backendTestsReadyFile(runId = schedulerRunId())
{
    return path.join(root, '.tmp/test-runs', runId, 'backend-tests-ready.json');
}

function frontendBuildReadyFile(runId = schedulerRunId())
{
    return path.join(root, '.tmp/test-runs', runId, 'frontend-build-ready.json');
}

function frontendBuildStageReceiptFile()
{
    const configured = String(process.env.FSUSBLOG_FRONTEND_BUILD_STAGE_RECEIPT ?? '').trim();
    if (!configured)
    {
        return path.join(productionBuildLayout.generatedRoot, 'frontend-build-stages.json');
    };
    return path.isAbsolute(configured)
        ? path.resolve(configured)
        : path.resolve(root, 'src/frontend', configured);
}

function expectedFrontendBuildStages()
{
    const generatedOnly = process.env.FSUSBLOG_VALIDATE_GENERATED_ONLY === '1';
    // frontend-build runs with FSUSBLOG_SKIP_BACKEND_WWWROOT_SYNC=1 so the stage
    // receipt records empty ownedOutputs for sync-backend-wwwroot. Validation must
    // re-create the same stage roster instead of assuming a live wwwroot sync.
    return createFrontendBuildStages(generatedOnly ? ['--check'] : [], generatedOnly ? 'check' : 'generate', {
        frontendRoot: path.join(root, 'src/frontend'),
        env: {
            ...process.env,
            FSUSBLOG_SKIP_BACKEND_WWWROOT_SYNC: process.env.FSUSBLOG_SKIP_BACKEND_WWWROOT_SYNC ?? '1'
        }
    });
}

function criticalFrontendBuildStageOutputs(stages = expectedFrontendBuildStages())
{
    const owned = new Set(stages.flatMap((stage) => stage.ownedOutputs));
    return [
        path.join(frontendDistRoot, 'index.html'),
        path.join(frontendDistRoot, 'server', 'public-shell-emergency.css'),
        path.join(frontendDistRoot, 'wasm'),
        path.join(frontendDistRoot, 'assets', 'fsus-spa-entry.js'),
        path.join(frontendDistRoot, 'dist'),
        path.join(frontendWasmRoot, 'wasm-manifest.aeds'),
        path.join(frontendWasmRoot, 'aeds-runtime-manifest.json'),
        backendWebRoot
    ].filter((candidate) => owned.has(candidate));
}

const runMarkerProducers = {
    'production-build-artifacts-ready': ['build-static', 'production-build-artifacts'],
    'pr-smart-gate-plan-ready': ['build-static', 'pr-smart-gate-plan'],
    'behavior-evidence-ready': ['backend-tests', 'behavior-evidence-pre-runtime'],
    'backend-coverage-ready': ['backend-tests', 'backend-coverage-summary'],
    'frontend-coverage-ready': ['frontend-tests', 'frontend-coverage-summary'],
    'runtime-state-ready': ['runtime-browser', 'runtime-state-stable'],
    'backend-quiet-ready': ['backend-tests', 'backend-tests-quiet'],
    'frontend-quiet-ready': ['frontend-tests', 'frontend-tests-quiet'],
    'build-static-quiet-ready': ['build-static', 'build-static-quiet']
};

function runMarkerFile(markerId)
{
    return path.join(root, '.tmp/test-runs', schedulerRunId(), `${markerId}.json`);
}

function currentSourceState()
{
    return {
        commit: process.env.FSUSBLOG_TEST_SOURCE_COMMIT,
        worktreeFingerprint: process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT
    };
}

function runtimeResetIdentity()
{
    return {
        runId: schedulerRunId(),
        namespace: String(process.env.FSUSBLOG_TEST_NAMESPACE ?? '').trim(),
        profileId,
        sourceState: currentSourceState()
    };
}

function loadRuntimeStateDomainCatalog()
{
    return JSON.parse(fs.readFileSync(
        path.join(root, 'config/testing/runtime-state-domain-catalog.json'),
        'utf8'
    ));
}

function resetReceiptArtifactsProducedByStep(catalog, stepId)
{
    const identity = runtimeResetIdentity();
    const resets = catalog.steps
        .flatMap((entry) => [...(entry.resetBefore ?? []), ...(entry.resetAfter ?? [])])
        .filter((reset) => reset.producer === stepId);
    return [...new Set(resets.map((reset) => resetPostconditionReceiptFile(root, {
        runId: identity.runId,
        producer: stepId,
        assertionId: reset.assertionId
    })))];
}

function currentRunMarkerArtifacts(markerId)
{
    const namespace = String(process.env.FSUSBLOG_TEST_NAMESPACE ?? '').trim();
    const environmentRoot = path.resolve(
        process.env.FSUSBLOG_ACCEPTANCE_ENV_ROOT ?? path.join(root, '.tmp/env'));
    return {
        'production-build-artifacts-ready': [productionBuildReceiptFile()],
        'pr-smart-gate-plan-ready': [
            path.join(root, '.tmp/pr-plan.json'),
            path.join(root, '.tmp/pr-changed-files.txt'),
            releaseEvidenceFile('pr-smart-gate-summary.json')
        ],
        'behavior-evidence-ready': [
            path.join(root, '.tmp/behavior-evidence-pre-runtime/receipt.json')
        ],
        'backend-coverage-ready': [coverageDirectory('backend-merged', 'Summary.json')],
        'frontend-coverage-ready': [coverageDirectory('frontend', 'Summary.json')],
        'runtime-state-ready': [path.join(environmentRoot, `${namespace}.env`)],
        'backend-quiet-ready': [runMarkerFile('backend-coverage-ready')],
        'frontend-quiet-ready': [runMarkerFile('frontend-coverage-ready')],
        'build-static-quiet-ready': [frontendBuildReadyFile()]
    }[markerId] ?? [];
}

function productionBuildArtifactRoot()
{
    if (!productionFreshLayout)
    {
        throw new Error('production build readiness requires a Production Fresh attempt layout');
    }
    return path.join(productionFreshLayout.outputRoot, 'artifacts', 'production-build');
}

function productionBuildReceiptFile()
{
    return path.join(productionBuildArtifactRoot(), 'receipt.json');
}

function productionBuildReadyBindings()
{
    const attemptId = String(process.env.FSUSBLOG_PRODUCTION_FRESH_ATTEMPT_ID ?? '').trim();
    if (!attemptId)
    {
        throw new Error('production build readiness requires an attempt id');
    }
    const { receipt } = verifyProductionBuildReceipt({
        artifactRoot: productionBuildArtifactRoot(),
        expectedSourceState: currentSourceState(),
        expectedProducer: {
            runId: schedulerRunId(),
            job: 'production-build-artifacts'
        },
        repairReadOnlySeal: false
    });
    return {
        attemptId,
        buildLayout: buildLayoutBinding(),
        receipt: {
            path: relative(productionBuildReceiptFile()),
            contentDigest: receipt.contentDigest
        },
        producer: receipt.producer
    };
}

function publishCurrentRunMarker(markerId, actualProducerStepId)
{
    const [producerBundleId, producerStepId] = runMarkerProducers[markerId] ?? [];
    if (bundleId !== producerBundleId || actualProducerStepId !== producerStepId)
    {
        throw new Error(`run-bound marker ${markerId} was published by the wrong producer context`);
    }
    const marker = publishRunBoundMarker({
        file: runMarkerFile(markerId),
        root,
        markerId,
        runId: schedulerRunId(),
        sourceState: currentSourceState(),
        producerBundleId,
        producerStepId,
        artifacts: currentRunMarkerArtifacts(markerId),
        ...(markerId === 'production-build-artifacts-ready'
            ? { bindings: productionBuildReadyBindings() }
            : {})
    });
    console.log(`[local-production:${bundleId}] run-marker=${marker.markerId}`);
    return marker;
}

function producerFailure(producerBundleId)
{
    const failure = readSchedulerProducerTerminalFailure({
        runsRoot: path.join(root, '.tmp/test-runs'),
        runId: schedulerRunId(),
        targetTierId: profileId,
        namespace: String(process.env.FSUSBLOG_TEST_NAMESPACE ?? '').trim(),
        sourceState: currentSourceState(),
        producerTierId: `local-${profileId}-${producerBundleId}`
    });
    return failure ? `${failure.status}: ${failure.reason}` : null;
}

async function waitForCurrentRunMarker(markerId)
{
    const [producerBundleId, producerStepId] = runMarkerProducers[markerId];
    const expected = {
        root,
        markerId,
        runId: schedulerRunId(),
        sourceState: currentSourceState(),
        producerBundleId,
        producerStepId,
        artifacts: currentRunMarkerArtifacts(markerId)
    };
    return waitForRunBoundMarker({
        file: runMarkerFile(markerId),
        expected,
        timeoutMs: bundleDeadlineMs(),
        pollIntervalMs: resolveMarkerPollIntervalMs(),
        signal: shutdownController.signal,
        producerFailure: () => producerFailure(producerBundleId),
        ...(markerId === 'production-build-artifacts-ready'
            ? {
          readMarker: (file, baseExpected) => readRunBoundMarker(file, {
            ...baseExpected,
            bindings: productionBuildReadyBindings()
          })
        }
            : {})
    });
}

function publishBackendBuildReady()
{
    const runId = schedulerRunId();
    const artifactPath = relative(backendServerDll);
    if (!fs.existsSync(backendServerDll))
    {
        throw new Error(`backend server build completed without server DLL: ${artifactPath}`);
    }
    const artifact = digestArtifacts([artifactPath], 'backend-build-ready');
    const marker = {
        schema: 'fsusblog.local-production.backend-build-ready.v1',
        status: 'success',
        physicalBundleId: 'backend-tests',
        schedulerRunId: runId,
        buildLayout: buildLayoutBinding(),
        serverDll: {
            path: artifactPath,
            exists: true,
            digest: artifact.digests[artifactPath],
            artifactRef: artifact.refs[artifactPath]
        },
        generatedAt: new Date().toISOString()
    };
    const markerFile = backendBuildReadyFile(runId);
    fs.mkdirSync(path.dirname(markerFile), { recursive: true });
    const temporary = `${markerFile}.next-${process.pid}-${randomUUID()}`;
    fs.writeFileSync(temporary, `${JSON.stringify(marker, null, 2)}\n`);
    fs.renameSync(temporary, markerFile);
    console.log(`[local-production:${bundleId}] backend-build-ready=${relative(markerFile)}`);
}

function publishBackendTestsReady()
{
    const runId = schedulerRunId();
    const artifactPath = relative(backendTestDll);
    if (!fs.existsSync(backendTestDll))
    {
        throw new Error(`backend tests build completed without test DLL: ${artifactPath}`);
    }
    const artifact = digestArtifacts([artifactPath], 'backend-tests-ready');
    const marker = {
        schema: 'fsusblog.local-production.backend-tests-ready.v1',
        status: 'success',
        physicalBundleId: 'backend-tests',
        schedulerRunId: runId,
        buildLayout: buildLayoutBinding(),
        testDll: {
            path: artifactPath,
            exists: true,
            digest: artifact.digests[artifactPath],
            contentDigest: fileContentDigest(backendTestDll),
            artifactRef: artifact.refs[artifactPath]
        },
        generatedAt: new Date().toISOString()
    };
    const markerFile = backendTestsReadyFile(runId);
    fs.mkdirSync(path.dirname(markerFile), { recursive: true });
    const temporary = `${markerFile}.next-${process.pid}-${randomUUID()}`;
    fs.writeFileSync(temporary, `${JSON.stringify(marker, null, 2)}\n`);
    fs.renameSync(temporary, markerFile);
    console.log(`[local-production:${bundleId}] backend-tests-ready=${relative(markerFile)}`);
}

function publishBenchmarkBuildReady()
{
    if (bundleId !== 'backend-tests')
    {
        throw new Error('benchmark build readiness was published outside backend-tests');
    }
    const runId = schedulerRunId();
    const artifactPath = relative(benchmarkDll);
    if (!fs.existsSync(benchmarkDll))
    {
        throw new Error(`benchmark readiness build completed without DLL: ${artifactPath}`);
    }
    const artifact = digestArtifacts([artifactPath], 'benchmark-build-ready');
    const marker = {
        schema: 'fsusblog.local-production.benchmark-build-ready.v1',
        status: 'success',
        physicalBundleId: 'backend-tests',
        producerStepId: 'backend-benchmark-build',
        schedulerRunId: runId,
        buildLayout: buildLayoutBinding(),
        benchmarkDll: {
            path: artifactPath,
            digest: artifact.digests[artifactPath],
            contentDigest: fileContentDigest(benchmarkDll),
            artifactRef: artifact.refs[artifactPath]
        },
        generatedAt: new Date().toISOString()
    };
    const markerFile = benchmarkBuildReadyFile(runId);
    fs.mkdirSync(path.dirname(markerFile), { recursive: true });
    const temporary = `${markerFile}.next-${process.pid}-${randomUUID()}`;
    fs.writeFileSync(temporary, `${JSON.stringify(marker, null, 2)}\n`);
    fs.renameSync(temporary, markerFile);
    console.log(`[local-production:${bundleId}] benchmark-build-ready=${relative(markerFile)}`);
}

function publishFrontendBuildReady()
{
    const runId = schedulerRunId();
    const expectedStages = expectedFrontendBuildStages();
    const artifactPath = relative(path.join(frontendDistRoot, 'index.html'));
    const privacyWasmPaths = [
        'comment-privacy-prover.js',
        ...(productionZkRequested() ? ['comment-privacy-prover.zkey', 'comment-privacy-prover.manifest.json'] : [])
    ].map((file) => relative(path.join(frontendWasmRoot, file)));
    const summaryPath = relative(path.join(
        process.env.FSUSBLOG_FRONTEND_OUTPUT_ROOT ?? path.join(root, '.tmp/frontend'),
        'frontend-build.json'));
    const stageReceiptFile = frontendBuildStageReceiptFile();
    const stageReceiptPath = relative(stageReceiptFile);
    const requiredArtifacts = [artifactPath, ...privacyWasmPaths];
    const frontendDistPath = relative(frontendDistRoot);
    const backendWebRootPath = relative(backendWebRoot);
    const missingArtifacts = [...requiredArtifacts, stageReceiptPath]
        .filter((requiredPath) => !fs.existsSync(path.join(root, requiredPath)));
    if (missingArtifacts.length > 0)
    {
        throw new Error(`frontend build completed without required artifact(s): ${missingArtifacts.join(', ')}`);
    }
    let stageReceipt;
    try
    {
        stageReceipt = JSON.parse(fs.readFileSync(stageReceiptFile, 'utf8'));
    }
    catch (error)
    {
        throw new Error(`frontend build stage receipt is unreadable: ${stageReceiptPath}`, { cause: error });
    }
    const stageReceiptIdentity = validateFrontendBuildStageReceiptIdentity(stageReceipt, {
        runId,
        sourceState: currentSourceState()
    });
    validateFrontendBuildStageReceiptBinding({
        root,
        marker: {
            stageReceipt: {
                path: stageReceiptPath,
                contentDigest: fileContentDigest(stageReceiptFile),
                identity: stageReceiptIdentity
            }
        },
        runId,
        sourceState: currentSourceState(),
        expectedPath: stageReceiptPath,
        expectedStages,
        stageCwd: path.join(root, 'src/frontend'),
        criticalOutputPaths: criticalFrontendBuildStageOutputs(expectedStages)
    });
    const artifacts = digestArtifacts(requiredArtifacts, 'frontend-build-ready');
    const artifactDigests = artifacts.digests;
    const generatedContractFile = path.join(productionBuildLayout.generatedRoot, 'frontend-build-contract.json');
    writeJsonAtomic(generatedContractFile, {
        schema: 'fsusblog.production-frontend-build-contract.v1',
        status: 'success',
        schedulerRunId: runId,
        buildLayout: buildLayoutBinding(),
        artifacts: Object.fromEntries(requiredArtifacts.map((requiredPath) => [requiredPath, {
            digest: artifactDigests[requiredPath],
            artifactRef: artifacts.refs[requiredPath]
        }])),
        generatedAt: new Date().toISOString()
    });
    const generatedContractPath = relative(generatedContractFile);
    const generatedContract = digestArtifacts([generatedContractPath], 'frontend-generated-contract');
    const generatedContractDigest = generatedContract.digests[generatedContractPath];
    const stageReceiptArtifact = digestArtifacts([stageReceiptPath], 'frontend-build-stage-receipt');
    const frontendDistArtifact = digestArtifacts([frontendDistPath], 'frontend-build-ready-dist');
    const backendWebRootArtifact = digestArtifacts([backendWebRootPath], 'frontend-build-ready-wwwroot');
    const publishedAt = new Date().toISOString();
    const marker = {
        schema: 'fsusblog.local-production.frontend-build-ready.v1',
        status: 'success',
        physicalBundleId: 'build-static',
        producerStepId: 'sync-static-assets',
        schedulerRunId: runId,
        buildLayout: buildLayoutBinding(),
        distEntry: {
            path: artifactPath,
            digest: artifactDigests[artifactPath],
            artifactRef: artifacts.refs[artifactPath]
        },
        privacyWasmArtifacts: Object.fromEntries(privacyWasmPaths.map((requiredPath) => [requiredPath, {
            path: requiredPath,
            digest: artifactDigests[requiredPath],
            artifactRef: artifacts.refs[requiredPath]
        }])),
        generatedContract: {
            path: generatedContractPath,
            digest: generatedContractDigest,
            artifactRef: generatedContract.refs[generatedContractPath]
        },
        stageReceipt: {
            path: stageReceiptPath,
            digest: stageReceiptArtifact.digests[stageReceiptPath],
            contentDigest: fileContentDigest(stageReceiptFile),
            artifactRef: stageReceiptArtifact.refs[stageReceiptPath],
            identity: stageReceiptIdentity
        },
        frontendDist: {
            path: frontendDistPath,
            digest: frontendDistArtifact.digests[frontendDistPath],
            artifactRef: frontendDistArtifact.refs[frontendDistPath]
        },
        backendWebRoot: {
            path: backendWebRootPath,
            digest: backendWebRootArtifact.digests[backendWebRootPath],
            artifactRef: backendWebRootArtifact.refs[backendWebRootPath]
        },
        publishedAt,
        generatedAt: publishedAt
    };
    for (const markerFile of [path.join(root, summaryPath), frontendBuildReadyFile(runId)])
    {
        fs.mkdirSync(path.dirname(markerFile), { recursive: true });
        const temporary = `${markerFile}.next-${process.pid}-${randomUUID()}`;
        fs.writeFileSync(temporary, `${JSON.stringify(marker, null, 2)}\n`);
        fs.renameSync(temporary, markerFile);
    }
    console.log(`[local-production:${bundleId}] frontend-build-ready=${relative(frontendBuildReadyFile(runId))}`);
}

function publishFrontendBuildTerminal(status, reason)
{
    const runId = schedulerRunId();
    const stageReceiptPath = relative(frontendBuildStageReceiptFile());
    publishFrontendBuildTerminalMarker({
        file: frontendBuildReadyFile(runId),
        runId,
        buildLayout: buildLayoutBinding(),
        status,
        reason,
        validateExistingSuccess: (marker) =>
        {
            if (!markerHasCurrentBuildLayout(marker) || marker.stageReceipt?.path !== stageReceiptPath)
            {
                return false;
            };
            validateFrontendBuildStageReceiptBinding({
                root,
                marker,
                runId,
                sourceState: currentSourceState(),
                expectedPath: stageReceiptPath,
                expectedStages: expectedFrontendBuildStages(),
                stageCwd: path.join(root, 'src/frontend'),
                criticalOutputPaths: criticalFrontendBuildStageOutputs()
            });
            return true;
        }
    });
}

function register(step, result, testIds = null, artifactFiles = [])
{
    const ids = testIds ?? [`command:${step.id}`];
    const declaredArtifacts = [...new Set([
        result.logFile,
        result.logIndexFile,
        result.logEvidenceFile,
        ...artifactFiles
    ].filter(Boolean))].map((file) =>
    {
        const absolute = path.isAbsolute(file) ? file : path.resolve(root, file);
        return relative(absolute);
    });
    const artifacts = digestArtifacts(declaredArtifacts, step.id);
    const artifactDigests = artifacts.digests;
    for (const tierId of step.members ?? [])
    {
        const evidence = memberEvidence.get(tierId);
        if (!evidence)
        {
            throw new Error(`${step.id} references undeclared member ${tierId}`);
        }
        evidence.durationMs += result.durationMs;
        evidence.testIds.push(...ids);
        Object.assign(evidence.artifactDigests, artifactDigests);
        Object.assign(evidence.artifactRefs, artifacts.refs);
    }
}

function bindMatrixRuntimeArtifacts()
{
    const substitutionsByTier = resolveArtifactSubstitutions(bundle, matrix.tiers);
    const runtimePathsByTier = new Map();
    const directRuntimePaths = [];
    const actualProofPaths = [];
    for (const [tierId, evidence] of memberEvidence)
    {
        const tier = matrixTiers.get(tierId);
        if (!tier)
        {
            throw new Error(`bundle member is missing from matrix tiers: ${tierId}`);
        }
        const runtimePaths = matrixGeneratedRuntimePaths(tier);
        const substitutions = substitutionsByTier[tierId] ?? {};
        runtimePathsByTier.set(tierId, runtimePaths);
        for (const runtimePath of runtimePaths)
        {
            const actualPaths = substitutions[runtimePath];
            if (actualPaths)
            {
                actualProofPaths.push(...actualPaths);
            }
            else
            {
                directRuntimePaths.push(runtimePath);
            }
        }
        evidence.artifactProofMode = runtimePaths.length === 0
            ? 'command-log-and-test-ids'
            : (Object.keys(substitutions).length > 0
          ? 'matrix-runtime-artifacts-with-substitutions'
          : 'matrix-runtime-artifacts');
        evidence.matrixRuntimePaths = runtimePaths;
        evidence.artifactSubstitutionProofs = {};
    }
    const allRuntimeArtifacts = digestArtifacts([
        ...new Set([...directRuntimePaths, ...actualProofPaths])
    ], 'matrix-runtime-artifacts');
    const allRuntimeDigests = allRuntimeArtifacts.digests;
    for (const [tierId, runtimePaths] of runtimePathsByTier)
    {
        const evidence = memberEvidence.get(tierId);
        const substitutions = substitutionsByTier[tierId] ?? {};
        for (const canonicalPath of runtimePaths)
        {
            const actualPaths = substitutions[canonicalPath];
            if (!actualPaths)
            {
                evidence.artifactDigests[canonicalPath] = allRuntimeDigests[canonicalPath];
                evidence.artifactRefs[canonicalPath] = allRuntimeArtifacts.refs[canonicalPath];
                continue;
            }
            const actualDigests = Object.fromEntries(actualPaths.map((actualPath) => [
                actualPath,
                allRuntimeDigests[actualPath]
            ]));
            const canonicalDigest = artifactSubstitutionBindingDigest(canonicalPath, actualDigests);
            const actualRefs = Object.fromEntries(actualPaths.map((actualPath) => [
                actualPath,
                allRuntimeArtifacts.refs[actualPath]
            ]));
            const substitution = artifactDigestTable.registerSubstitution(
                canonicalPath,
                actualDigests,
                actualRefs,
                { producer: { bundle: bundleId, step: 'artifact-substitution' } }
            );
            if (substitution.digest !== canonicalDigest)
            {
                throw new Error(`artifact substitution table digest mismatch: ${canonicalPath}`);
            }
            evidence.artifactDigests[canonicalPath] = canonicalDigest;
            Object.assign(evidence.artifactDigests, actualDigests);
            evidence.artifactRefs[canonicalPath] = substitution.artifactId;
            Object.assign(evidence.artifactRefs, actualRefs);
            evidence.artifactSubstitutionProofs[canonicalPath] = {
                canonicalPath,
                canonicalDigest,
                actualPaths,
                actualDigests,
                actualRefs,
                canonicalArtifactRef: substitution.artifactId
            };
        }
    }
}

function memberReceiptPath(tierId)
{
    return path.join(outDir, 'member-summaries', tierId, 'summary.json');
}

function writeMemberExecutionReceipts()
{
    for (const [tierId, evidence] of memberEvidence)
    {
        const receiptFile = memberReceiptPath(tierId);
        const receipt = {
            schema: 'fsusblog.local-production.member-execution.v1',
            status: 'success',
            tierId,
            physicalBundleId: bundleId,
            schedulerRunId: process.env.FSUSBLOG_TEST_RUN_ID ?? null,
            sourceState: {
                commit: process.env.FSUSBLOG_TEST_SOURCE_COMMIT ?? null,
                worktreeFingerprint: process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT ?? null
            },
            durationMs: evidence.durationMs,
            testIds: [...new Set(evidence.testIds)].sort(),
            directArtifactDigests: Object.fromEntries(Object.entries(evidence.artifactDigests).sort()),
            directArtifactRefs: Object.fromEntries(Object.entries(evidence.artifactRefs).sort()),
            generatedAt: new Date().toISOString()
        };
        fs.mkdirSync(path.dirname(receiptFile), { recursive: true });
        const temporary = `${receiptFile}.next-${process.pid}`;
        fs.writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`);
        fs.renameSync(temporary, receiptFile);
        const receiptArtifact = digestArtifacts([relative(receiptFile)], `member-receipt/${tierId}`);
        Object.assign(evidence.artifactDigests, receiptArtifact.digests);
        Object.assign(evidence.artifactRefs, receiptArtifact.refs);
    }
}

function loadExistingMemberExecutionReceipts()
{
    for (const [tierId, evidence] of memberEvidence)
    {
        const receiptFile = memberReceiptPath(tierId);
        if (!fs.existsSync(receiptFile))
        {
            throw new Error(`existing member receipt is missing: ${relative(receiptFile)}`);
        }
        const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
        if (receipt.schema !== 'fsusblog.local-production.member-execution.v1' || receipt.status !== 'success')
        {
            throw new Error(`existing member receipt is invalid: ${relative(receiptFile)}`);
        }
        if (receipt.tierId !== tierId || receipt.physicalBundleId !== bundleId)
        {
            throw new Error(`existing member receipt identity mismatch: ${relative(receiptFile)}`);
        }
        if (receipt.schedulerRunId !== (process.env.FSUSBLOG_TEST_RUN_ID ?? null))
        {
            throw new Error(`existing member receipt run mismatch: ${relative(receiptFile)}`);
        }
        evidence.durationMs = receipt.durationMs;
        evidence.testIds.push(...receipt.testIds);
        Object.assign(evidence.artifactDigests, receipt.directArtifactDigests);
        Object.assign(evidence.artifactRefs, receipt.directArtifactRefs);
        const receiptArtifact = digestArtifacts([relative(receiptFile)], `existing-member-receipt/${tierId}`);
        Object.assign(evidence.artifactDigests, receiptArtifact.digests);
        Object.assign(evidence.artifactRefs, receiptArtifact.refs);
    }
}

async function executeStep(step)
{
    const measurementEvidenceFile = step.evidencePhase === 'measurement'
        ? path.join(logDir, `${step.id}.measurement-noise.json`)
        : null;
    const measurementAuthorityRoot = measurementEvidenceFile
        ? measurementAuthorityRootFor(step.id)
        : null;
    const measurementAuthorityManifestRoot = measurementEvidenceFile
        ? measurementAuthorityManifestRootFor(step.id)
        : null;
    const priorMeasurementAuthorityRoots = measurementEvidenceFile
        ? priorMeasurementAuthorityRootsFor(step.id)
        : [];
    if (measurementEvidenceFile)
    {
        step = {
            ...step,
            artifacts: [...(step.artifacts ?? []), relative(measurementEvidenceFile)]
        };
    }
    stepDeclarations.set(step.id, step);
    beginPhysicalProducer(step);
    if (shutdownPromise)
    {
        throw new Error(`cannot start ${step.id} while bundle shutdown is in progress`);
    }
    const logFile = path.join(logDir, `${step.id}.log`);
    let started = Date.now();
    if (step.resources?.coordinationOnly === true)
    {
        const canonicalDependencyIds = [...(step.dependsOn ?? []), ...(step.settledDependsOn ?? [])];
        const relativeDependencyResults = new Map(canonicalDependencyIds.flatMap((dependencyId) =>
        {
            const result = stepExecutionResults.get(dependencyId);
            return result
                ? [[dependencyId, { ...result, logFile: relative(result.logFile) }]]
                : [];
        }));
        const joined = buildSettledPhaseJoinEvidence({
            stepId: step.id,
            dependencyIds: canonicalDependencyIds,
            dependencyOutcomes: step.dependencyOutcomes,
            dependencyResults: relativeDependencyResults,
            evidenceRef: relative(logFile)
        });
        const joinEvidence = joined.evidence;
        fs.writeFileSync(logFile, `${JSON.stringify(joinEvidence, null, 2)}\n`);
        const result = {
            code: 0,
            signal: null,
            durationMs: joined.durationMs,
            startedAtMs: joined.startedAtMs,
            finishedAtMs: joined.finishedAtMs,
            logFile
        };
        recordPhysicalProducerResult(step, {
            ...result,
            status: joinEvidence.status,
            terminalState: joinEvidence.terminalState,
            evidenceRef: joinEvidence.evidenceRef,
            contentDigest: joinEvidence.contentDigest,
            dependencyOutcomeDigest: joinEvidence.dependencyOutcomeDigest,
            primaryFailureRefs: joinEvidence.primaryFailureRefs,
            dependencyOutcomes: joinEvidence.dependencies
        });
        stepResourceMetrics.set(step.id, {
            status: 'not-applicable',
            wallSeconds: result.durationMs / 1000,
            actualCpuSeconds: null,
            grantedCpuSeconds: null,
            cpuGrantEfficiency: null
        });
        console.log(`[local-production:${bundleId}] joined ${step.id} status=${joinEvidence.status} durationMs=${result.durationMs}`);
        register(step, result, step.testIds, [...joined.dependencyLogs, ...(step.artifacts ?? [])]);
        return {
            ...result,
            terminalState: joinEvidence.terminalState,
            reasonCode: joinEvidence.reasonCode,
            primaryFailureRefs: joinEvidence.primaryFailureRefs,
            dependencyOutcomes: joinEvidence.dependencies,
            evidence: joinEvidence,
            evidenceRef: joinEvidence.evidenceRef,
            dependencyOutcomeDigest: joinEvidence.dependencyOutcomeDigest,
            contentDigest: joinEvidence.contentDigest
        };
    }
    const stepCapacity = resolveStepRuntimeCapacity(bundleId, step, bundleCapacity());
    const stepOsLimits = resolveCgroupLimits(stepCapacity, {
        cpuUnits: os.availableParallelism?.() ?? os.cpus().length,
        memoryGiB: os.totalmem() / (1024 ** 3)
    });
    stepEffectiveLimits.set(step.id, stepOsLimits);
    const remainingBundleDeadlineMs = Math.max(1, bundleDeadlineMs() - (Date.now() - startedAt));
    const stepDeadlineMs = Math.min(remainingBundleDeadlineMs, resolveMachineExecutionTimeoutMs({
        baseTimeoutMs: remainingBundleDeadlineMs,
        workload: step.resources,
        actualCapacity: stepCapacity
    }));
    console.log(
        `[local-production:${bundleId}] start ${step.id}`
    + ` cpu=${stepCapacity.cpuUnits.toFixed(2)}`
    + ` memoryGiB=${stepCapacity.memoryGiB.toFixed(2)}`
    + ` parallel=${stepCapacity.maxParallel}`
    + ` deadlineMs=${stepDeadlineMs}`
    );
    const childBaseEnvironment = { ...process.env };
    // Playwright sets FORCE_COLOR for its workers. Inheriting an ambient
    // NO_COLOR at the same time emits one warning per worker and violates the
    // release zero-warning contract without changing test semantics.
    delete childBaseEnvironment.NO_COLOR;
    for (const stalePhysicalWorkerCap of [
        'FSUSBLOG_COMMAND_MANIFEST_WORKERS',
        'FSUSBLOG_VITEST_MAX_WORKERS',
        'FSUSBLOG_PLAYWRIGHT_WORKERS'
    ])
    {
        delete childBaseEnvironment[stalePhysicalWorkerCap];
    }
    const gnuTimeFile = path.join(logDir, `${step.id}.resource-time.txt`);
    const useGnuTime = process.platform === 'linux' && fs.existsSync('/usr/bin/time');
    fs.rmSync(gnuTimeFile, { force: true });
    const workloadExecutable = useGnuTime ? '/usr/bin/time' : '/bin/bash';
    const workloadArgs = useGnuTime
        ? ['-f', gnuTimeFormat, '-o', gnuTimeFile, '--', '/bin/bash', '-lc', step.command]
        : ['-lc', step.command];
    const measurementWindowId = measurementEvidenceFile
        ? `${schedulerRunId()}/${bundleId}/${step.id}`
        : null;
    const wrappedCommand = measurementEvidenceFile
        ? wrapTaskScopedMeasurementCommand({
        windowId: measurementWindowId,
        evidenceFile: measurementEvidenceFile,
        command: [workloadExecutable, ...workloadArgs],
        runId: schedulerRunId(),
        authorityRoot: measurementAuthorityRoot,
        authorityManifestRoot: measurementAuthorityManifestRoot,
        priorAuthorityRoots: priorMeasurementAuthorityRoots
      })
        : { executable: workloadExecutable, args: workloadArgs };
    const { executable, args } = wrappedCommand;
    const logPipeline = createAsyncLogPipeline({
        root,
        file: logFile,
        // Production's parent scheduler owns a separate bundle-control log. Full
        // child bytes stay in this step's authoritative stream so they are not
        // copied into the parent tier log a second time. An explicit diagnostic
        // session may opt into the bounded derived console sink.
        teeOutput: process.env.FSUSBLOG_PRODUCTION_CHILD_CONSOLE_TEE === '1'
    });
    const child = spawn(executable, args, {
        cwd: root,
        detached: process.platform !== 'win32',
        env: {
            ...childBaseEnvironment,
            ...runtimeChildEnvironment,
            ...(step.env ?? {}),
            // Production bundles are short-lived and can be cancelled at their
            // deadline. Persistent MSBuild nodes otherwise detach with PPID 1 and
            // continue consuming this run's CPU/memory after the bundle exits.
            MSBUILDDISABLENODEREUSE: '1',
            FSUSBLOG_STEP_CPU_BUDGET: String(stepCapacity.cpuUnits),
            FSUSBLOG_STEP_MEMORY_GIB: String(stepCapacity.memoryGiB),
            FSUSBLOG_BUNDLE_CPU_BUDGET: String(stepCapacity.maxParallel),
            FSUSBLOG_BUNDLE_CPU_UNITS: String(stepCapacity.cpuUnits),
            FSUSBLOG_BUNDLE_MEMORY_GIB: String(stepCapacity.memoryGiB),
            FSUSBLOG_STEP_DEADLINE_MS: String(stepDeadlineMs),
            FSUSBLOG_STEP_ID: step.id,
            FSUSBLOG_DOCKER_CPU_UNITS: String(stepCapacity.cpuUnits),
            FSUSBLOG_DOCKER_MEMORY_HIGH_BYTES: String(stepOsLimits.memoryHighBytes),
            FSUSBLOG_DOCKER_MEMORY_MAX_BYTES: String(stepOsLimits.memoryMaxBytes),
            FSUSBLOG_DOCKER_PIDS_MAX: String(stepOsLimits.pidsMax)
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
    });
    const resourceCollector = createLinuxProcessTreeCollector({
        rootPid: child.pid,
        grantProvider: () =>
        {
            const capacity = resolveStepRuntimeCapacity(bundleId, step, bundleCapacity());
            return { cpuUnits: capacity.cpuUnits, memoryGiB: capacity.memoryGiB };
        },
        sampleIntervalMs: resolveResourceSampleIntervalMs({
            cpuUnits: stepCapacity.cpuUnits,
            benchmark: (step.resources?.exclusiveResources ?? []).includes('benchmark-window')
        })
    });
    const terminationGraceMs = Math.max(100, Math.min(5_000, Math.ceil(stepDeadlineMs * 0.02)));
    activeStepChildren.set(child, { terminationGraceMs, stepId: step.id, logPipeline });
    logPipeline.attach(child.stdout, 'stdout');
    logPipeline.attach(child.stderr, 'stderr');
    const exit = await new Promise((resolve) =>
    {
        let settled = false;
        let deadlineExpired = false;
        let removeLogFailure = () =>
        {};
        const settle = (result) =>
        {
            if (settled)
            {
                return;
            }
            settled = true;
            clearTimeout(deadlineTimer);
            removeLogFailure();
            activeStepChildren.delete(child);
            resolve(result);
        };
        const deadlineTimer = setTimeout(async () =>
        {
            if (settled)
            {
                return;
            }
            deadlineExpired = true;
            await terminateProcessGroup(child, terminationGraceMs);
            closeChildPipes(child);
            settle({
                code: 124,
                signal: null,
                timedOut: true,
                logComplete: false,
                logTruncationReason: 'step-deadline-forced-close'
            });
        }, stepDeadlineMs);
        deadlineTimer.unref?.();

        removeLogFailure = logPipeline.onFailure((error) =>
        {
            void (async () =>
            {
                if (settled)
                {
                    return;
                }
                await terminateProcessGroup(child, terminationGraceMs);
                closeChildPipes(child);
                settle({
                    code: 1,
                    signal: null,
                    error: new Error(`authoritative log pipeline failed: ${error.message}`, { cause: error }),
                    logComplete: false,
                    logTruncationReason: 'writer-error'
                });
            })();
        });

        child.once('error', (error) =>
        {
            closeChildPipes(child);
            settle({
                code: 1,
                signal: null,
                error,
                logComplete: false,
                logTruncationReason: 'child-spawn-error'
            });
        });
        child.once('close', (code, signal) =>
        {
            if (deadlineExpired)
            {
                return;
            }
            settle({ code: code ?? 1, signal });
        });
    });
    const logFinalization = await logPipeline.close({
        complete: exit.logComplete !== false,
        truncationReason: exit.logTruncationReason ?? null
    });
    const finalizedExit = logFinalization.error && !exit.error
        ? {
        ...exit,
        code: 1,
        error: new Error(
          `authoritative log pipeline failed: ${logFinalization.error.message}`,
          { cause: logFinalization.error }
        )
      }
        : exit;
    const finishedAtMs = Date.now();
    const result = {
        ...finalizedExit,
        durationMs: finishedAtMs - started,
        startedAtMs: started,
        finishedAtMs,
        logFile,
        logIndexFile: logFinalization.indexFile,
        logEvidenceFile: logFinalization.evidenceFile,
        logEvidence: logFinalization.evidence
    };
    if (measurementEvidenceFile)
    {
        result.measurementAuthorityRoot = measurementAuthorityRoot;
        result.measurementAuthorityManifestRoot = measurementAuthorityManifestRoot;
        try
        {
            const sequence = readMeasurementNoiseAuthoritySequence(measurementEvidenceFile, {
                authorityRoot: measurementAuthorityRoot,
                authorityManifestRoot: measurementAuthorityManifestRoot,
                priorAuthorityRoots: priorMeasurementAuthorityRoots,
                expectedRunId: schedulerRunId(),
                expectedWindowId: measurementWindowId
            });
            const measurementNoiseEnvelope = sequence.at(-1);
            result.measurementNoiseEnvelope = measurementNoiseEnvelope;
            if (measurementNoiseEnvelope.status === 'clean')
            {
                validateMeasurementNoiseReceipt(measurementNoiseEnvelope, {
                    expectedWindowId: measurementWindowId,
                    authoritySequence: sequence
                });
                result.durationMs = measurementNoiseEnvelope.timing.measurementDurationMs;
                result.startedAtMs = result.finishedAtMs - result.durationMs;
            }
            else
            {
                const error = new Error(
                    `${step.id} failed measurement qualification: ${measurementNoiseEnvelope.classification}`
                );
                error.classification = measurementNoiseEnvelope.classification;
                error.evidence = measurementNoiseEnvelope;
                result.code = 1;
                result.error = error;
            }
        }
        catch (error)
        {
            result.code = 1;
            result.error = new Error(
                `measurement authority validation failed: ${error.message}`,
                { cause: error }
            );
        }
    }
    const resourceUtilization = resourceCollector.stop({
        gnuTime: useGnuTime ? parseGnuTimeReport(gnuTimeFile) : null
    });
    const resourceAndLogEvidence = {
        ...resourceUtilization,
        log: logFinalization.evidence
    };
    stepResourceMetrics.set(step.id, resourceAndLogEvidence);
    result.resourceUtilization = resourceAndLogEvidence;
    if (result.timedOut)
    {
        recordPhysicalProducerResult(step, { ...result, status: 'timed-out', terminalState: 'timed-out' });
        throw new StepTerminalError('timed-out', 'machine-resolved-deadline-exceeded', `${step.id} exceeded machine-resolved deadline (${stepDeadlineMs}ms)`);
    }
    if (result.error)
    {
        const terminalState = shutdownController.signal.aborted ? 'cancelled' : 'failed';
        recordPhysicalProducerResult(step, { ...result, status: terminalState, terminalState });
        throw new StepTerminalError(terminalState, shutdownController.signal.aborted ? 'bundle-shutdown' : 'step-execution-error', result.error.message, { cause: result.error });
    }
    if (result.code !== 0 || result.signal)
    {
        const terminalState = shutdownController.signal.aborted ? 'cancelled' : 'failed';
        recordPhysicalProducerResult(step, { ...result, status: terminalState, terminalState });
        throw new StepTerminalError(terminalState, shutdownController.signal.aborted ? 'bundle-shutdown' : 'non-zero-exit', `${step.id} failed (${result.signal ? `signal ${result.signal}` : `exit ${result.code}`})`);
    }
    // A dependent step must not become runnable until the producer's readiness
    // marker is durably published. Keeping this hook inside executeStep closes
    // the gap between child exit and the DAG completion notification.
    try
    {
        if (typeof step.afterSuccess === 'function')
        {
            await step.afterSuccess(result);
        }
    }
    catch (error)
    {
        const terminalState = shutdownController.signal.aborted ? 'cancelled' : 'failed';
        recordPhysicalProducerResult(step, {
            ...result,
            status: terminalState,
            terminalState,
            error: error instanceof Error ? error : new Error(String(error))
        });
        throw new StepTerminalError(
            terminalState,
      shutdownController.signal.aborted ? 'bundle-shutdown' : 'after-success-hook-failed',
      error instanceof Error ? error.message : String(error),
      { cause: error instanceof Error ? error : undefined }
        );
    }
    recordPhysicalProducerResult(step, { ...result, status: 'success', terminalState: 'success' });
    console.log(`[local-production:${bundleId}] done ${step.id} durationMs=${result.durationMs}`);
    register(step, result, step.testIds, step.artifacts ?? []);
    return result;
}

function beginPhysicalProducer(step)
{
    stepDeclarations.set(step.id, step);
    if (productionFreshLayout && !producerBeforeInventories.has(step.id))
    {
        producerBeforeInventories.set(step.id, captureProductionFreshOutputInventory(productionFreshLayout));
    }
}

function recordPhysicalProducerResult(step, result)
{
    stepExecutionResults.set(step.id, result);
    if (productionFreshLayout)
    {
        producerAfterInventories.set(
            step.id,
            captureProductionFreshOutputInventory(productionFreshLayout)
        );
    }
    return result;
}

function collectRegularOutputFiles(candidate, files = [])
{
    if (!fs.existsSync(candidate))
    {
        return files;
    }
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink())
    {
        throw new Error(`producer output must not be a symlink: ${relative(candidate)}`);
    }
    if (stat.isFile())
    {
        files.push(candidate);
        return files;
    }
    if (!stat.isDirectory())
    {
        throw new Error(`producer output must be regular: ${relative(candidate)}`);
    }
    for (const name of fs.readdirSync(candidate))
    {
        collectRegularOutputFiles(path.join(candidate, name), files);
    }
    return files;
}

function writePhysicalProducerReceipts({
    status = 'success',
    failure = null,
    finalizerBefore = null
} = {})
{
    if (!runOutputRoot)
    {
        return;
    }
    const partial = status !== 'success';
    const declaredProducers = new Set(productionFreshProducerInventory.bundles[bundleId] ?? []);
    assertProductionFreshBundleProducerWiring(bundleId, stepExecutionResults.keys(), {
        status: partial ? 'partial' : 'success'
    });
    const receiptRoot = outputDirectory('artifacts', 'producer-receipts', bundleId);
    fs.mkdirSync(receiptRoot, { recursive: true });
    const declarations = new Map();
    for (const [stepId, result] of [...stepExecutionResults.entries()].sort(([left], [right]) => left.localeCompare(right)))
    {
        const declaration = stepDeclarations.get(stepId);
        if (!declaration)
        {
            throw new Error(`physical producer declaration is missing: ${bundleId}/${stepId}`);
        }
        const receiptFile = path.join(receiptRoot, `${stepId}.json`);
        if (partial && fs.existsSync(receiptFile))
        {
            const existing = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
            if (existing?.schema !== 'fsusblog.production-fresh.producer-receipt.v1'
        || existing.runId !== productionFreshLayout.runId
        || existing.attemptId !== productionFreshLayout.attemptId
        || existing.producerId !== `${bundleId}/${stepId}`
        || !Array.isArray(existing.relativeOutputs)
        || existing.relativeOutputs.length === 0)
            {
                throw new Error(`existing physical producer receipt is invalid: ${bundleId}/${stepId}`);
            }
            declarations.set(stepId, {
                before: null,
                after: null,
                relativeOutputs: existing.relativeOutputs,
                existing: true,
                result
            });
            continue;
        }
        const candidates = [
            result.logFile,
            result.logIndexFile,
            result.logEvidenceFile,
            result.measurementAuthorityRoot,
            result.measurementAuthorityManifestRoot,
            path.join(logDir, `${stepId}.resource-time.txt`),
            ...(declaration.artifacts ?? []).map((artifact) => path.isAbsolute(artifact) ? artifact : path.join(root, artifact))
        ].filter(Boolean);
        const ownedOutputRoots = [...new Set(candidates
            .filter((candidate) => (
                candidate === runOutputRoot || candidate.startsWith(`${runOutputRoot}${path.sep}`)
            ))
            .map((candidate) => path.relative(runOutputRoot, candidate).replaceAll(path.sep, '/')))]
            .sort();
        const files = [...new Set(candidates.flatMap((candidate) => collectRegularOutputFiles(candidate)))]
            .filter((file) => file === runOutputRoot || file.startsWith(`${runOutputRoot}${path.sep}`))
            .sort();
        if (files.length === 0)
        {
            if (partial)
            {
                continue;
            }
            throw new Error(`physical producer ${bundleId}/${stepId} recorded no run-bound outputs`);
        }
        const before = producerBeforeInventories.get(stepId);
        if (!before)
        {
            throw new Error(`physical producer start inventory is missing: ${bundleId}/${stepId}`);
        }
        const after = producerAfterInventories.get(stepId);
        if (!after)
        {
            throw new Error(`physical producer settled inventory is missing: ${bundleId}/${stepId}`);
        }
        const relativeOutputs = files
            .map((file) => path.relative(runOutputRoot, file).replaceAll(path.sep, '/'))
            .filter((relativeOutput) => before[relativeOutput] !== after[relativeOutput]);
        if (relativeOutputs.length === 0)
        {
            if (partial)
            {
                continue;
            }
            throw new Error(`physical producer ${bundleId}/${stepId} changed no run-bound outputs`);
        }
        declarations.set(stepId, {
            before,
            after,
            relativeOutputs,
            ownedOutputRoots,
            existing: false,
            result
        });
    }
    const finalizerRelativeOutputs = partial
        ? [
        path.relative(runOutputRoot, summaryFile).replaceAll(path.sep, '/'),
        path.relative(runOutputRoot, path.join(outDir, 'resource-utilization.json')).replaceAll(path.sep, '/')
      ]
        : [];
    if (partial && (finalizerBefore === null
    || finalizerRelativeOutputs.some((relativeOutput) => (
        !fs.existsSync(path.join(runOutputRoot, relativeOutput))
    ))))
    {
        throw new Error(`physical failure finalizer outputs are incomplete: ${bundleId}`);
    }
    const finalizerAfter = captureProductionFreshOutputInventory(productionFreshLayout);
    const allDeclaredOutputs = [...new Set(
        [...declarations.values()].flatMap(({ relativeOutputs }) => relativeOutputs)
    )];
    const governanceOutputs = Object.keys(productionFreshGovernanceOutputs(productionFreshLayout));
    const receipts = [];
    for (const [
        stepId,
        { before, after, relativeOutputs, ownedOutputRoots, existing, result }
    ] of declarations)
    {
        if (existing)
        {
            continue;
        }
        const allowedRemovedOutputs = Object.keys(before)
            .filter((relativeOutput) => (
                !Object.hasOwn(after, relativeOutput)
        && isProductionFreshExpectedLifecycleRemoval(relativeOutput)
            ));
        const receipt = verifyProducerOutputDelta({
            layout: productionFreshLayout,
            producerId: `${bundleId}/${stepId}`,
            before,
            after,
            relativeOutputs,
            ownedOutputRoots,
            allowedRemovedOutputs,
            allowedConcurrentOutputs: [
                ...allDeclaredOutputs.filter((relativeOutput) => !relativeOutputs.includes(relativeOutput)),
                ...governanceOutputs
            ]
        });
        receipts.push({
            ...receipt,
            schema: 'fsusblog.production-fresh.producer-receipt.v1',
            status: result.status === 'success' ? 'complete' : 'partial',
            terminalState: result.terminalState ?? result.status ?? null
        });
    }
    if (partial)
    {
        const allowedRemovedOutputs = Object.keys(finalizerBefore)
            .filter((relativeOutput) => (
                !Object.hasOwn(finalizerAfter, relativeOutput)
        && isProductionFreshExpectedLifecycleRemoval(relativeOutput)
            ));
        const receipt = verifyProducerOutputDelta({
            layout: productionFreshLayout,
            producerId: `${bundleId}/failure-finalizer`,
            before: finalizerBefore,
            after: finalizerAfter,
            relativeOutputs: finalizerRelativeOutputs,
            ownedOutputRoots: finalizerRelativeOutputs,
            allowedRemovedOutputs,
            allowedConcurrentOutputs: [
                ...allDeclaredOutputs,
                ...governanceOutputs.filter(
                    (relativeOutput) => !finalizerRelativeOutputs.includes(relativeOutput))
            ]
        });
        receipts.push({
            ...receipt,
            schema: 'fsusblog.production-fresh.producer-receipt.v1',
            status: 'partial',
            terminalState: failure?.terminalState ?? 'failed',
            failure: failure instanceof Error ? failure.message : String(failure ?? 'bundle failed')
        });
    }
    for (const receipt of receipts)
    {
        const stepId = receipt.producerId.slice(bundleId.length + 1);
        const receiptFile = path.join(receiptRoot, `${stepId}.json`);
        fs.writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
    }
    if (!partial)
    {
        const missing = [...declaredProducers].filter((producerId) => (
            !stepExecutionResults.has(producerId)
      || !fs.existsSync(path.join(receiptRoot, `${producerId}.json`))
        ));
        if (missing.length > 0)
        {
            throw new Error(`physical producer receipts are missing: ${missing.join(', ')}`);
        }
    }
}

async function executeBundleStepDag(steps, capacity, executor)
{
    try
    {
        const execution = await executeWeightedStepDag(steps, capacity, executor);
        schedulerTerminalReceipts = { ...schedulerTerminalReceipts, ...execution.terminalReceipts };
        return execution;
    }
    catch (error)
    {
        if (error?.terminalReceipts)
        {
            schedulerTerminalReceipts = { ...schedulerTerminalReceipts, ...error.terminalReceipts };
        }
        throw error;
    }
}

async function executeWave(steps)
{
    return executeBundleStepDag(steps, bundleDagCapacity, executeStep);
}

function schedulerResourceGrant()
{
    const grantFile = String(process.env.FSUSBLOG_SCHEDULER_RESOURCE_GRANT_FILE ?? '').trim();
    const tierId = String(process.env.FSUSBLOG_SCHEDULER_RESOURCE_GRANT_TIER_ID ?? '').trim();
    if (!grantFile || !tierId || !fs.existsSync(grantFile))
    {
        return null;
    }
    const document = JSON.parse(fs.readFileSync(grantFile, 'utf8'));
    if (document?.schema !== 'fsusblog.test-matrix.resource-grants.v1')
    {
        throw new Error(`invalid scheduler resource grant schema: ${relative(grantFile)}`);
    }
    if (document.runId !== schedulerRunId())
    {
        throw new Error(`scheduler resource grant belongs to another run: ${document.runId ?? '<missing>'}`);
    }
    const grant = document.grants?.[tierId];
    if (!grant)
    {
        return null;
    }
    if (!Number.isFinite(Number(grant.cpuUnits)) || Number(grant.cpuUnits) <= 0
    || !Number.isFinite(Number(grant.memoryGiB)) || Number(grant.memoryGiB) <= 0)
    {
        throw new Error(`scheduler resource grant is invalid for ${tierId}`);
    }
    return {
        cpuUnits: Number(grant.cpuUnits),
        memoryGiB: Number(grant.memoryGiB)
    };
}

function bundleCapacity()
{
    const liveGrant = schedulerResourceGrant();
    return resolveBundleRuntimeCapacity({
        availableCpu: os.availableParallelism?.() ?? os.cpus().length,
        availableMemoryGiB: os.freemem() / (1024 ** 3),
        inheritedCpuBudget: liveGrant?.cpuUnits ?? process.env.FSUSBLOG_BUNDLE_CPU_BUDGET,
        inheritedMemoryGiB: liveGrant?.memoryGiB ?? process.env.FSUSBLOG_BUNDLE_MEMORY_GIB,
        cpuWeight: bundle.cpuWeight,
        memoryWeight: bundle.memoryWeight
    });
}

function bundleDagCapacity()
{
    const capacity = bundleCapacity();
    return {
        ...capacity,
        signal: shutdownController.signal,
        exclusiveResources: bundle.exclusiveResources ?? [],
        onWaitState: (stepId, state) => waitLedger.observe(stepId, state)
    };
}

function bundleDagCapacityForSteps(steps)
{
    const capacity = bundleDagCapacity();
    const stepExclusiveResources = steps.flatMap((entry) => entry.resources?.exclusiveResources ?? []);
    return {
        ...capacity,
        ...(runtimeScheduleControl
            ? { maxParallel: Math.min(capacity.maxParallel, runtimeScheduleControl.plan.concurrencyCap) }
            : {}),
        exclusiveResources: [...new Set([
            ...(capacity.exclusiveResources ?? []),
            ...stepExclusiveResources
        ])],
        ...(runtimeStateConflictPolicy ? { stateConflictPolicy: runtimeStateConflictPolicy } : {})
    };
}

function resolveRuntimeScheduleControl(steps)
{
    const planFile = String(process.env.FSUSBLOG_RUNTIME_SCHEDULE_PLAN ?? '').trim();
    if (!planFile)
    {
        return null;
    }
    const sessionReceiptFile = String(process.env.FSUSBLOG_RUNTIME_SESSION_RECEIPT ?? '').trim();
    if (!sessionReceiptFile)
    {
        throw new Error('explicit runtime schedule requires a sealed RuntimeExecutionSession receipt');
    }
    const plan = JSON.parse(fs.readFileSync(path.resolve(planFile), 'utf8'));
    const sessionReceipt = JSON.parse(fs.readFileSync(path.resolve(sessionReceiptFile), 'utf8'));
    validateRuntimeExecutionSessionReceipt(sessionReceipt);
    if (sessionReceipt.identity.runId !== schedulerRunId()
      || sessionReceipt.identity.sourceCommit !== process.env.FSUSBLOG_TEST_SOURCE_COMMIT
      || sessionReceipt.identity.sourceFingerprint !== process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT)
    {
        throw new Error('runtime schedule session receipt is stale for the current scheduler source/run');
    }
    validateRuntimeSchedulePlan(plan, {
        steps,
        allowedCaps: [...new Set([1, Math.min(2, bundleDagCapacity().maxParallel), bundleDagCapacity().maxParallel])],
        expected: {
            runtimeStepCatalogDigest: runtimeStepCatalogDigest(steps),
            stateCatalogDigest: runtimeStateAuthority.catalogDigest,
            clockDigest: sessionReceipt.identity.clockDigest,
            replayDigest: sessionReceipt.identity.replayDigest,
            envelopeDigest: sessionReceipt.identity.envelopeDigest
        }
    });
    return { plan, sessionReceipt, planFile: path.resolve(planFile), sessionReceiptFile: path.resolve(sessionReceiptFile) };
}

function bundleDeadlineMs()
{
    if (profile.enforceBudget === false)
    {
    // Observe-only production must not inherit the optimization target as a
    // kill switch. Retain only the matrix's existing per-tier fault ceiling so
    // a genuinely wedged child cannot keep the machine forever.
        const declaredFaultCeilings = (bundle.members ?? [])
            .map((tierId) => Number(matrixTiers.get(tierId)?.timeoutMinutes) * 60_000)
            .filter((value) => Number.isFinite(value) && value > 0);
        return Math.max(profile.budgetMs, ...declaredFaultCeilings);
    }
    const deadlineMs = Number(process.env.FSUSBLOG_BUNDLE_DEADLINE_MS);
    if (Number.isFinite(deadlineMs) && deadlineMs > 0)
    {
        return deadlineMs;
    }
    return resolveMachineExecutionTimeoutMs({
        baseTimeoutMs: profile.budgetMs,
        workload: {
            cpuWeight: bundle.cpuWeight,
            memoryWeight: bundle.memoryWeight,
            minCpuUnits: bundle.minCpuUnits
        },
        actualCapacity: bundleCapacity()
    });
}

function resolveExecutionWaitTimeoutMs(dependencyBundleIds)
{
    dependencyBundleIds.forEach((dependencyBundleId) =>
    {
        const dependency = profile.bundles.find((entry) => entry.id === dependencyBundleId);
        if (!dependency)
        {
            throw new Error(`unknown dependency bundle: ${dependencyBundleId}`);
        }
    });
    return resolveMachineExecutionTimeoutMs({
        baseTimeoutMs: bundleDeadlineMs(),
        workload: bundle,
        actualCapacity: bundleCapacity()
    });
}

function resolveMarkerPollIntervalMs()
{
    const cpuUnits = Math.max(1, Number(bundleCapacity().cpuUnits) || 1);
    return Math.max(10, Math.min(250, Math.ceil(1000 / cpuUnits)));
}

function cancellationError(label)
{
    const reason = shutdownController.signal.reason;
    return new Error(`cancelled waiting for ${label}: ${reason instanceof Error ? reason.message : String(reason ?? 'bundle shutdown')}`);
}

async function waitForCoordinationPoll(waitMs, label)
{
    if (shutdownController.signal.aborted)
    {
        throw cancellationError(label);
    }
    await new Promise((resolve, reject) =>
    {
        const onAbort = () =>
        {
            clearTimeout(timer);
            shutdownController.signal.removeEventListener('abort', onAbort);
            reject(cancellationError(label));
        };
        const timer = setTimeout(() =>
        {
            shutdownController.signal.removeEventListener('abort', onAbort);
            resolve();
        }, Math.max(1, waitMs));
        shutdownController.signal.addEventListener('abort', onAbort, { once: true });
        if (shutdownController.signal.aborted)
        {
            onAbort();
        }
    });
}

function commandStep(id, command, members, options = {})
{
    return {
        id,
        command,
        members,
        ...options,
        resources: options.resources ?? { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 }
    };
}

function buildStaticSteps()
{
    return [
        commandStep('backend-tests-ready', null, [], {
            dependsOn: ['validate-matrix'],
            resources: { coordinationOnly: true }
        }),
        commandStep('frontend-build', 'cd src/frontend && FSUSBLOG_SKIP_BACKEND_WWWROOT_SYNC=1 npm run build:release', ['frontend-build'], {
            dependsOn: ['validate-matrix'],
            artifacts: [path.join(frontendDistRoot, 'index.html')],
            resources: {
                cpuWeight: 2,
                memoryWeight: 2,
                minCpuUnits: 1,
                exclusiveResources: ['build-output']
            }
        }),
        commandStep('validate-matrix', 'node tools/run-test-matrix.mjs validate-declarations && tools/test/run-matrix-governance-once.sh validate-matrix', ['validate-declarations', 'validate-matrix']),
        commandStep('pr-smart-gate-plan', 'tools/test/lanes/plan-pr-risk.sh', ['pr-smart-gate-plan'], {
            dependsOn: ['validate-matrix'],
            artifacts: currentRunMarkerArtifacts('pr-smart-gate-plan-ready'),
            afterSuccess: () => publishCurrentRunMarker(
                'pr-smart-gate-plan-ready',
                'pr-smart-gate-plan'
            )
        }),
        commandStep('public-hydration-fast', 'tools/test/lanes/public-hydration-fast.sh', ['public-hydration-fast'], {
            dependsOn: ['validate-matrix']
        }),
        commandStep('perception-redteam', 'tools/test/lanes/perception-v2-redteam.sh pr', ['perception-v2-redteam-pr'], {
            dependsOn: ['validate-matrix']
        }),
        commandStep('risk-control', 'tools/test/lanes/risk-control-test-matrix.sh', ['risk-control-test-matrix'], {
            dependsOn: ['validate-matrix'],
            artifacts: [path.join(process.env.FSUSBLOG_SECURITY_OUTPUT_ROOT ?? path.join(root, '.tmp/security'), 'risk-control-test-matrix.json')]
        }),
        commandStep('viewport-plan-progress', 'node tools/ux/run-viewport-plan-progress.mjs', ['ux-viewport-plan-progress'], {
            dependsOn: ['validate-matrix'],
            artifacts: [path.join(process.env.FSUSBLOG_UX_OUTPUT_ROOT ?? path.join(root, '.tmp/ux'), 'viewport-plan-progress.json')]
        }),
        commandStep('sync-static-assets', [
            'rm -rf "$FSUSBLOG_BACKEND_WEBROOT"',
            'mkdir -p "$FSUSBLOG_BACKEND_WEBROOT"',
            'cp -R "$FSUSBLOG_FRONTEND_DIST_ROOT"/. "$FSUSBLOG_BACKEND_WEBROOT"/'
        ].join(' && '), ['frontend-build'], { dependsOn: ['frontend-build'] }),
        commandStep(
            'production-build-artifacts',
            'FSUSBLOG_CI_PRODUCTION_REUSE_BUILD_OUTPUTS=1 bash tools/test/lanes/production-build-artifacts.sh',
            ['production-build-artifacts'],
            {
                dependsOn: ['frontend-build', 'backend-tests-ready'],
                artifacts: [
                    path.join(
                        process.env.FSUSBLOG_CI_PRODUCTION_ARTIFACT_ROOT ?? path.join(root, '.tmp/ci-production-build'),
                        'receipt.json'
                    ),
                    releaseEvidenceFile('production-build-cache.json'),
                    releaseEvidenceFile('production-build-cache', 'domains')
                ],
                afterSuccess: () => publishCurrentRunMarker(
                    'production-build-artifacts-ready',
                    'production-build-artifacts'
                )
            }
        ),
        commandStep('frontend-runtime-contracts', 'cd src/frontend && FSUSBLOG_COMMAND_MANIFEST_WORKERS="$FSUSBLOG_STEP_CPU_BUDGET" node ../../tools/test/run-command-manifest.mjs --matrix-group frontend-runtime-contracts', ['frontend-runtime-contracts'], { dependsOn: ['sync-static-assets'] }),
        commandStep('wasm-fuzz', 'tools/test/lanes/wasm-fuzz-regression.sh', ['wasm-fuzz-regression'], {
            dependsOn: ['frontend-build'],
            artifacts: [
                path.join(process.env.FSUSBLOG_FUZZ_EVIDENCE_DIR ?? path.join(root, '.tmp/fuzz'), 'wasm'),
                releaseEvidenceFile('fuzz-seeds.json')
            ]
        })
    ];
}

function trxAttribute(text, name)
{
    const match = text.match(new RegExp(`\\b${name}="([^"]*)"`, 'u'));
    return match?.[1] ?? '';
}

function parseTrx(file)
{
    const xml = fs.readFileSync(file, 'utf8');
    const definitions = new Map();
    for (const match of xml.matchAll(/<UnitTest\b([^>]*)>([\s\S]*?)<\/UnitTest>/gu))
    {
        const id = trxAttribute(match[1], 'id');
        const method = match[2].match(/<TestMethod\b([^>]*)\/>/u)?.[1] ?? '';
        const categories = [...match[2].matchAll(/TestCategory="([^"]+)"/gu)].map((entry) => entry[1]);
        definitions.set(id, {
            id: `${trxAttribute(method, 'className')}.${trxAttribute(method, 'name')}`,
            categories
        });
    }
    return [...xml.matchAll(/<UnitTestResult\b([^>]*)\/?>(?:<\/UnitTestResult>)?/gu)].map((match) =>
    {
        const definition = definitions.get(trxAttribute(match[1], 'testId')) ?? {};
        return {
            id: definition.id || trxAttribute(match[1], 'testName'),
            outcome: trxAttribute(match[1], 'outcome'),
            categories: definition.categories ?? []
        };
    }).filter((entry) => entry.id);
}

function readPerceptionUnionProjection(trxFiles, shardSummary)
{
    const projectionFile = backendTrxDirectory('production', 'perception-v2-union-projection.json');
    if (!fs.existsSync(projectionFile))
    {
        throw new Error('perception-v2 union projection is missing');
    }
    const projection = JSON.parse(fs.readFileSync(projectionFile, 'utf8'));
    if (projection.schema !== 'fsusblog.perception-v2.union-projection.v1' || projection.status !== 'success')
    {
        throw new Error('perception-v2 union projection is not a successful v1 result');
    }
    const runId = schedulerRunId();
    if (projection.producer?.runId !== runId)
    {
        throw new Error(`perception-v2 union projection runId mismatch: expected ${runId}, received ${projection.producer?.runId ?? '<missing>'}`);
    }
    const dllPath = relative(backendTestDll);
    const expectedDllDigest = fileContentDigest(path.resolve(root, dllPath));
    if (projection.testDll?.path !== dllPath || projection.testDll?.digest !== expectedDllDigest)
    {
        throw new Error('perception-v2 union projection is not bound to the current backend test DLL digest');
    }
    const summaryPath = relative(shardSummary);
    const expectedSummaryDigest = fileContentDigest(path.resolve(root, summaryPath));
    if (projection.unionSummary?.path !== summaryPath || projection.unionSummary?.digest !== expectedSummaryDigest)
    {
        throw new Error('perception-v2 union projection is not bound to the current union summary digest');
    }
    const expectedTrxDigests = Object.fromEntries(
        trxFiles.map((file) => [relative(file), fileContentDigest(file)])
    );
    const projectedTrx = Array.isArray(projection.trxFiles) ? projection.trxFiles : [];
    const projectedTrxDigests = Object.fromEntries(projectedTrx.map((entry) => [entry?.path, entry?.digest]));
    if (projectedTrx.length !== trxFiles.length
    || Object.keys(projectedTrxDigests).length !== trxFiles.length
    || Object.entries(expectedTrxDigests).some(([file, digest]) => projectedTrxDigests[file] !== digest))
    {
        throw new Error('perception-v2 union projection is not bound to the exact current TRX digest set');
    }
    const expectedTests = [
        'FsusBlog.Server.Tests.Unit.PerceptionChallengeV2E2eTests.CommentCreateFlow_FailsClosedForWrongAnswerExpiredReplayAndBindingMismatch',
        'FsusBlog.Server.Tests.Unit.PerceptionChallengeV2E2eTests.CommentCreateFlow_IssueRenderVerifyProofResume_WritesReleaseEvidence'
    ].sort();
    const tests = Array.isArray(projection.tests) ? projection.tests : [];
    if (tests.length !== expectedTests.length
    || tests.some((entry) => entry?.outcome !== 'Passed')
    || JSON.stringify(tests.map((entry) => entry?.id).sort()) !== JSON.stringify(expectedTests))
    {
        throw new Error('perception-v2 union projection has missing, unexpected, duplicate, or non-passing canonical test results');
    }
    return { projectionFile, tests };
}

async function runBackendTests()
{
    const trxRoot = backendTrxDirectory('production');
    const shardSummary = path.join(trxRoot, 'summary.json');
    const coverageDir = coverageDirectory('backend', 'production');
    fs.mkdirSync(trxRoot, { recursive: true });
    fs.mkdirSync(coverageDir, { recursive: true });
    await executeWave([
        commandStep('services', 'tools/bootstrap-acceptance-env.sh --services-only', [], {
            resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 }
        }),
        commandStep('dotnet-restore',
            'FSUSBLOG_DOTNET_BUILD_PARALLELISM=auto tools/build-with-data-env.sh dotnet restore tests/FsusBlog.ProductionBackend.slnx --locked-mode -v minimal /p:NuGetAudit=false', [], {
                resources: { cpuWeight: 2, memoryWeight: 1.5, minCpuUnits: 1 }
            })
    ]);
    const backendBuildStep = commandStep('backend-server-build',
        'tools/build-with-data-env.sh dotnet build src/backend/FsusBlog.Server.csproj -c Release --no-restore -warnaserror -v minimal /m:"$FSUSBLOG_STEP_CPU_BUDGET" /p:UseSharedCompilation=true /p:NuGetAudit=false',
        ['backend-build-governance'], {
            artifacts: [backendServerDll],
            resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 }
        });
    await executeStep(backendBuildStep);
    publishBackendBuildReady();
    const testsBuildStep = commandStep('backend-tests-build',
        'tools/build-with-data-env.sh dotnet build tests/backend/FsusBlog.Server.Tests.csproj -c Release --no-restore --no-dependencies --no-incremental -warnaserror -v minimal /m:"$FSUSBLOG_STEP_CPU_BUDGET" /p:UseSharedCompilation=true /p:NuGetAudit=false',
        ['backend-build-governance'], {
            artifacts: [backendTestDll],
            resources: { cpuWeight: 2, memoryWeight: 2, minCpuUnits: 1 },
            afterSuccess: publishBackendTestsReady
        });
    const migrationTestsBuildStep = commandStep('migration-tests-build',
        'tools/build-with-data-env.sh dotnet build tests/migration/FsusBlog.Migration.Tests.csproj -c Release --no-restore -warnaserror -v minimal /m:"$FSUSBLOG_STEP_CPU_BUDGET" /p:UseSharedCompilation=true /p:NuGetAudit=false',
        ['backend-build-governance'], {
            artifacts: [migrationTestDll],
            resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 }
        });
    const xunitAdapterBuildStep = commandStep('xunit-inventory-adapter-build',
        'tools/build-with-data-env.sh dotnet build tools/test-inventory/xunit-roslyn-adapter/FsusBlog.XunitRoslynAdapter.csproj -c Release --no-restore --no-dependencies -warnaserror -v minimal /m:"$FSUSBLOG_STEP_CPU_BUDGET" /p:UseSharedCompilation=true /p:NuGetAudit=false',
        ['backend-build-governance'], {
            artifacts: [xunitAdapterDll, runMarkerFile('migration-tests-ready')],
            resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 },
            afterSuccess: () => publishMigrationBuildReady({
                root,
                runId: schedulerRunId(),
                namespace: String(process.env.FSUSBLOG_TEST_NAMESPACE ?? '').trim(),
                sourceState: currentSourceState()
            })
        });
    const benchmarkBuildStep = commandStep('backend-benchmark-build',
        'tools/build-with-data-env.sh dotnet build benchmarks/core/FsusBlog.Core.Benchmarks.csproj -c Release --no-restore --no-dependencies -warnaserror -v minimal /m:"$FSUSBLOG_STEP_CPU_BUDGET" /p:UseSharedCompilation=true /p:NuGetAudit=false',
        ['backend-build-governance'], {
            artifacts: [benchmarkDll],
            resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 },
            afterSuccess: publishBenchmarkBuildReady
        });
    // With the startup grant fully occupied by the test union, an independent
    // benchmark build cannot be admitted until the union finishes. Build this
    // small prerequisite first so performance work can overlap the long union.
    await executeStep(testsBuildStep);
    await executeStep(migrationTestsBuildStep);
    await executeStep(xunitAdapterBuildStep);
    await executeStep(benchmarkBuildStep);
    const migrationContext = {
        root,
        runId: schedulerRunId(),
        namespace: String(process.env.FSUSBLOG_TEST_NAMESPACE ?? '').trim(),
        sourceState: currentSourceState()
    };
    const migrationPaths = migrationExecutionPaths(migrationContext);
    const migrationStep = commandStep('migration-test-execution',
        'tools/build-with-data-env.sh node tools/test/run-migration-tests.mjs', [], {
            artifacts: [migrationPaths.directory],
            resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 },
            afterSuccess: () => readMigrationExecution(migrationContext)
        });
    const migrationResult = await executeStep(migrationStep);
    const migrationExecution = await readMigrationExecution(migrationContext);
    register({ id: migrationStep.id, members: ['backend-unit', 'backend-fast'] }, migrationResult,
        migrationExecution.summary.sourceCaseIds, [migrationPaths.directory]);
    const assemblyPending = migrationAssemblyPendingPaths({ ...migrationContext, producer: 'backend-tests',
        attemptId: String(process.env.FSUSBLOG_PRODUCTION_FRESH_ATTEMPT_ID ?? '') });
    await executeStep(commandStep('migration-assembly-verification',
        'tools/build-with-data-env.sh node tools/db/generate-migration-assembly-receipt.mjs --write', [], {
            artifacts: [assemblyPending.directory],
            resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 }
        }));
    const testStep = commandStep('dotnet-production-union',
        'FSUSBLOG_BACKEND_CPU_BUDGET="$FSUSBLOG_STEP_CPU_BUDGET" node tools/test/run-backend-production-shards.mjs', [], {
            resources: {
                cpuWeight: 2,
                memoryWeight: 3,
                minCpuUnits: 2,
                minMemoryGiB: backendTopologyDefaults.memoryGiBPerTesthost * 2
            },
            afterSuccess: publishBackendTestsReady
        });
    const backendDagResults = new Map();
    await executeBundleStepDag([
        testStep,
        commandStep('perception-matrix',
            'tools/test/lanes/perception-v2-test-matrix.sh', [], {
                dependsOn: ['dotnet-production-union'],
                artifacts: [backendTrxDirectory('production', 'perception-v2-union-projection.json')]
            }),
        commandStep('perception-evidence-finalize',
            'test -s "$FSUSBLOG_PERCEPTION_RUNTIME_EVIDENCE_FILE" -a -s "$FSUSBLOG_PERCEPTION_RELEASE_EVIDENCE_FILE" -a -s "$FSUSBLOG_PERCEPTION_MATRIX_SUMMARY_FILE"', [], {
                dependsOn: ['perception-matrix'],
                artifacts: [
                    perceptionRuntimeEvidenceFile(),
                    perceptionReleaseEvidenceFile(),
                    perceptionMatrixSummaryFile()
                ]
            }),
        commandStep('backend-coverage-summary',
            'node tools/coverage/backend-coverage-pipeline.mjs merge --manifest "$FSUSBLOG_COVERAGE_ROOT/backend/production/universe.json" --out "$FSUSBLOG_COVERAGE_ROOT/backend-merged"', [], {
                dependsOn: ['dotnet-production-union']
            })
    ], bundleDagCapacity, async (step) =>
    {
        const result = await executeStep(step);
        if (step.id === 'backend-coverage-summary')
        {
            publishCurrentRunMarker('backend-coverage-ready', step.id);
        }
        backendDagResults.set(step.id, result);
    });
    const result = backendDagResults.get('dotnet-production-union');
    if (!result)
    {
        throw new Error('dotnet-production-union completed without a result');
    }
    const shardReport = JSON.parse(fs.readFileSync(shardSummary, 'utf8'));
    const trxFiles = listFiles(trxRoot, (file) => file.endsWith('.trx')).sort();
    validateShardSummaryArtifacts(shardReport, trxFiles, { repositoryRoot: root });
    const tests = trxFiles.flatMap(parseTrx);
    const integrityCatalogFile = path.join(root, 'tests/fixtures/evidence-projection/integrity-proof-verification.json');
    const integrityProducerFile = reportDirectory('backend', 'evidence-producers', 'backend-unit.json');
    const integritySourceFile = reportDirectory('backend', 'integrity-proof-source.json');
    const integrityProjectionFile = releaseEvidenceFile('integrity-proof-verification.json');
    const integrityCatalog = JSON.parse(fs.readFileSync(integrityCatalogFile, 'utf8'));
    const integrityProduced = writeIntegrityProofProducer({
        catalog: integrityCatalog,
        trxFiles,
        repositoryRoot: root,
        sourceState: currentSourceState(),
        runId: schedulerRunId(),
        namespace: String(process.env.FSUSBLOG_TEST_NAMESPACE ?? '').trim(),
        producerOutput: integrityProducerFile,
        sourceOutput: integritySourceFile
    });
    const integrityProjection = projectEvidence({
        catalog: integrityCatalog,
        producerReceipt: integrityProduced.receipt,
        producerReceiptPath: relative(integrityProducerFile),
        sourceState: currentSourceState(),
        runId: schedulerRunId(),
        namespace: String(process.env.FSUSBLOG_TEST_NAMESPACE ?? '').trim(),
        repositoryRoot: root
    });
    writeJsonAtomic(integrityProjectionFile, integrityProjection);
    register({ id: 'integrity-proof-projection', members: ['integrity-proof-verification'] }, result,
        integrityProjection.assertions.flatMap((entry) => entry.sourceTestIds.map((id) => `xunit:${id}`)), [
            integrityProjectionFile,
            integrityProducerFile,
            integritySourceFile,
            integrityCatalogFile,
            ...trxFiles
        ]);
    const perceptionProjection = readPerceptionUnionProjection(trxFiles, shardSummary);
    register({ id: 'perception-union-projection', members: ['perception-v2-test-matrix'] }, result,
        perceptionProjection.tests.map((entry) => `xunit:${entry.id}`), [
            perceptionProjection.projectionFile,
            shardSummary,
            backendTestDll,
            ...trxFiles,
            perceptionRuntimeEvidenceFile(),
            perceptionReleaseEvidenceFile(),
            perceptionMatrixSummaryFile()
        ]);
    const categoryMembers = new Map([
        ['backend-api-integration', 'ApiIntegration'],
        ['backend-auth-state-machine', 'SecurityStateMachine'],
        ['backend-concurrency', 'Concurrency'],
        ['backend-property', 'Property'],
        ['backend-golden', 'GoldenContract']
    ]);
    const categoryMethods = new Map([...categoryMembers].map(([tierId, category]) =>
    {
        const methods = shardReport.categoryMembership?.[category]?.testMethods;
        if (!Array.isArray(methods) || methods.length === 0)
        {
            throw new Error(`${tierId} is missing bound category discovery evidence for ${category}`);
        }
        return [tierId, new Set(methods)];
    }));
    const specialMethods = new Set([...categoryMethods.values()].flatMap((methods) => [...methods]));
/* eslint-disable @stylistic/brace-style, @stylistic/indent, @stylistic/semi, curly */
  const distributedContractClasses = [
    'DistributedContractFastTests',
    'DistributedInvalidationBusTests',
    'DistributedInvalidationTargetResolverTests',
    'DistributedInvalidationLocalApplierTests',
    'PublicAotBackfillLeaseTests',
    'ArticleMutationProjectionCheckpointTests',
    'ArticleMutationOutboxFailurePropagationTests'
  ]
  const backendTestMembers = new Set([
    'backend-unit', 'distributed-contract-fast', 'backend-api-integration', 'backend-auth-state-machine', 'backend-concurrency',
    'backend-property', 'backend-golden', 'backend-fast', 'coverage-backend'
  ])
  for (const tierId of bundle.members.filter((id) => backendTestMembers.has(id))) {
    let selected = tests
    if (tierId === 'backend-unit') selected = tests.filter((entry) => !specialMethods.has(entry.id))
    else if (tierId === 'distributed-contract-fast') {
      selected = tests.filter((entry) => distributedContractClasses.some((className) => entry.id.includes(`.${className}.`)))
    }
    else if (categoryMethods.has(tierId)) selected = tests.filter((entry) => categoryMethods.get(tierId).has(entry.id))
    if (selected.length === 0) throw new Error(`${tierId} received no executed backend test IDs`)
    register({ id: 'dotnet-production-union', members: [tierId] }, result, selected.map((entry) => `xunit:${entry.id}`), [
      shardSummary,
      ...trxFiles,
      coverageDirectory('backend-merged', 'Summary.json')
    ])
  }
    /* eslint-enable @stylistic/brace-style, @stylistic/indent, @stylistic/semi, curly */
    await waitForCurrentRunMarker('pr-smart-gate-plan-ready');
    const behaviorTestStep = commandStep(
        'behavior-test-evidence',
        'tools/test/lanes/behavior-test-evidence.sh',
        ['behavior-test-evidence'],
        {
            artifacts: [path.join(root, '.tmp/behavior-test-evidence')]
        }
    );
    await executeStep(behaviorTestStep);
    const mutationStep = commandStep(
        'backend-mutation-changed-critical',
        'FSUSBLOG_MUTATION_SCOPE=pr tools/test/lanes/backend-mutation-changed-critical.sh',
        ['backend-mutation-changed-critical'],
        {
            artifacts: [path.join(root, '.tmp/mutation/changed-critical')]
        }
    );
    await executeStep(mutationStep);
    const preRuntimeStep = commandStep(
        'behavior-evidence-pre-runtime',
        'tools/test/bundles/behavior-evidence-pre-runtime.sh',
        ['behavior-evidence-pre-runtime'],
        {
            artifacts: [path.join(root, '.tmp/behavior-evidence-pre-runtime/receipt.json')],
            afterSuccess: () => publishCurrentRunMarker(
                'behavior-evidence-ready',
                'behavior-evidence-pre-runtime'
            )
        }
    );
    await executeStep(preRuntimeStep);
}

function listFiles(directory, predicate = () => true)
{
    if (!fs.existsSync(directory))
    {
        return [];
    }
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    {
        const child = path.join(directory, entry.name);
        return entry.isDirectory() ? listFiles(child, predicate) : (predicate(child) ? [child] : []);
    });
}

function parseVitestReports(files)
{
    const records = [];
    for (const file of files)
    {
        const report = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (const testFile of report.testResults ?? [])
        {
            for (const assertion of testFile.assertionResults ?? [])
            {
                records.push({
                    id: `vitest:${assertion.fullName || assertion.title}`,
                    status: assertion.status,
                    file: testFile.name || file
                });
            }
        }
    }
    return records;
}

async function waitForBackendProductionSummaryReady(timeoutMs = resolveExecutionWaitTimeoutMs(['backend-tests']))
{
    const expectedRunId = schedulerRunId();
    const summaryFile = backendTrxDirectory('production', 'summary.json');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline)
    {
        if (fs.existsSync(summaryFile))
        {
            try
            {
                const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
                if (summary?.producer?.runId === expectedRunId)
                {
                    if (summary.schema !== 'fsusblog.backend-production-shards.v2'
              || summary.status !== 'success'
              || summary.execution?.exactOnce !== true
              || summary.execution?.allPassed !== true
              || !Array.isArray(summary.partitions)
              || summary.partitions.length < 2)
                    {
                        throw new Error('current-run backend production summary is not an exact-once all-passing partition union');
                    }
                    const trxFiles = summary.partitions.map((partition) => path.resolve(root, partition.trx ?? ''));
                    if (trxFiles.some((file) => !fs.existsSync(file)))
                    {
                        throw new Error('current-run backend production summary references a missing TRX');
                    }
                    validateShardSummaryArtifacts(summary, trxFiles, { repositoryRoot: root });
                    return;
                }
            }
            catch (error)
            {
                if (!(error instanceof SyntaxError))
                {
                    throw new Error(`invalid run-bound backend production summary: ${error.message}`, { cause: error });
                }
            }
        }
        const failure = producerFailure('backend-tests');
        if (failure)
        {
            throw new Error(`backend-tests ${failure} before production summary readiness`);
        }
        await waitForCoordinationPoll(250, 'backend production summary');
    }
    throw new Error(`timed out waiting for run-bound backend production summary: ${expectedRunId}`);
}

async function waitForBackendBuildReady(timeoutMs = resolveExecutionWaitTimeoutMs(['backend-tests']))
{
    const expectedRunId = schedulerRunId();
    const markerFile = backendBuildReadyFile(expectedRunId);
    const artifactPath = relative(backendServerDll);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline)
    {
        if (fs.existsSync(markerFile))
        {
            try
            {
                const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
                if (marker.schema !== 'fsusblog.local-production.backend-build-ready.v1'
            || marker.status !== 'success'
            || marker.physicalBundleId !== 'backend-tests'
            || marker.schedulerRunId !== expectedRunId
            || !markerHasCurrentBuildLayout(marker)
            || marker.serverDll?.path !== artifactPath
            || marker.serverDll?.exists !== true)
                {
                    throw new Error(`backend build readiness marker is not bound to scheduler run ${expectedRunId}`);
                }
                if (!fs.existsSync(backendServerDll))
                {
                    throw new Error(`backend build readiness artifact is missing: ${artifactPath}`);
                }
                const expectedDigest = marker.serverDll.digest;
                const actual = digestArtifacts([artifactPath], 'consume-backend-build-ready');
                const actualDigest = actual.digests[artifactPath];
                if (!expectedDigest || actualDigest !== expectedDigest
          || marker.serverDll.artifactRef !== actual.refs[artifactPath])
                {
                    throw new Error(`backend build readiness digest mismatch: ${artifactPath}`);
                }
                return;
            }
            catch (error)
            {
                throw new Error(`invalid run-bound backend build readiness marker: ${error.message}`, { cause: error });
            }
        }
        const failure = producerFailure('backend-tests');
        if (failure)
        {
            throw new Error(`backend-tests ${failure} before backend build readiness`);
        }
        await waitForCoordinationPoll(250, 'backend build readiness');
    }
    throw new Error(`timed out waiting for run-bound backend build readiness: ${expectedRunId}`);
}

async function waitForBackendTestsReady(timeoutMs = resolveExecutionWaitTimeoutMs(['backend-tests']))
{
    const expectedRunId = schedulerRunId();
    const markerFile = backendTestsReadyFile(expectedRunId);
    const artifactPath = relative(backendTestDll);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline)
    {
        if (fs.existsSync(markerFile))
        {
            try
            {
                const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
                if (marker.schema !== 'fsusblog.local-production.backend-tests-ready.v1'
            || marker.status !== 'success'
            || marker.physicalBundleId !== 'backend-tests'
            || marker.schedulerRunId !== expectedRunId
            || !markerHasCurrentBuildLayout(marker)
            || marker.testDll?.path !== artifactPath
            || marker.testDll?.exists !== true)
                {
                    throw new Error(`backend tests readiness marker is not bound to scheduler run ${expectedRunId}`);
                }
                if (!fs.existsSync(backendTestDll))
                {
                    throw new Error(`backend tests readiness artifact is missing: ${artifactPath}`);
                }
                const expectedDigest = marker.testDll.digest;
                const actual = digestArtifacts([artifactPath], 'consume-backend-tests-ready');
                const actualDigest = actual.digests[artifactPath];
                if (!expectedDigest || actualDigest !== expectedDigest
          || marker.testDll.artifactRef !== actual.refs[artifactPath])
                {
                    throw new Error(`backend tests readiness digest mismatch: ${artifactPath}`);
                }
                return;
            }
            catch (error)
            {
                throw new Error(`invalid run-bound backend tests readiness marker: ${error.message}`, { cause: error });
            }
        }
        const failure = producerFailure('backend-tests');
        if (failure)
        {
            throw new Error(`backend-tests ${failure} before backend tests readiness`);
        }
        await waitForCoordinationPoll(250, 'backend tests readiness');
    }
    throw new Error(`timed out waiting for run-bound backend tests readiness: ${expectedRunId}`);
}

async function waitForFrontendBuildReady(timeoutMs = resolveExecutionWaitTimeoutMs(['build-static']))
{
    const expectedRunId = schedulerRunId();
    const markerFile = frontendBuildReadyFile(expectedRunId);
    const artifactPath = relative(path.join(frontendDistRoot, 'index.html'));
    const privacyWasmPaths = [
        'comment-privacy-prover.js',
        ...(productionZkRequested() ? ['comment-privacy-prover.zkey', 'comment-privacy-prover.manifest.json'] : [])
    ].map((file) => relative(path.join(frontendWasmRoot, file)));
    const generatedContractPath = relative(path.join(productionBuildLayout.generatedRoot, 'frontend-build-contract.json'));
    const stageReceiptPath = relative(frontendBuildStageReceiptFile());
    const frontendDistPath = relative(frontendDistRoot);
    const backendWebRootPath = relative(backendWebRoot);
    const expectedStages = expectedFrontendBuildStages();
    const startedAtMs = Date.now();
    const readiness = await waitForRunBoundMarker({
        file: markerFile,
        expected: { markerId: 'frontend-build-ready' },
        timeoutMs,
        pollIntervalMs: resolveMarkerPollIntervalMs(),
        signal: shutdownController.signal,
        producerFailure: () => producerFailure('build-static'),
        readMarker: () =>
        {
            try
            {
                const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
                if (marker.schema !== 'fsusblog.local-production.frontend-build-ready.v1'
            || marker.status !== 'success'
            || marker.physicalBundleId !== 'build-static'
            || marker.producerStepId !== 'sync-static-assets'
            || marker.schedulerRunId !== expectedRunId
            || !markerHasCurrentBuildLayout(marker)
            || marker.distEntry?.path !== artifactPath
            || marker.generatedContract?.path !== generatedContractPath
            || marker.stageReceipt?.path !== stageReceiptPath
            || marker.frontendDist?.path !== frontendDistPath
            || marker.backendWebRoot?.path !== backendWebRootPath
            || privacyWasmPaths.some((requiredPath) => marker.privacyWasmArtifacts?.[requiredPath]?.path !== requiredPath))
                {
                    throw new Error(`frontend build readiness marker is not bound to scheduler run ${expectedRunId}`);
                }
                const stageReceipt = validateFrontendBuildStageReceiptBinding({
                    root,
                    marker,
                    runId: expectedRunId,
                    sourceState: currentSourceState(),
                    expectedPath: stageReceiptPath,
                    expectedStages,
                    stageCwd: path.join(root, 'src/frontend'),
                    criticalOutputPaths: criticalFrontendBuildStageOutputs(expectedStages)
                });
                const requiredArtifacts = [
                    artifactPath,
                    ...privacyWasmPaths,
                    generatedContractPath,
                    stageReceiptPath,
                    frontendDistPath,
                    backendWebRootPath
                ];
                const missingArtifacts = requiredArtifacts.filter((requiredPath) => !fs.existsSync(path.join(root, requiredPath)));
                if (missingArtifacts.length > 0)
                {
                    throw new Error(`frontend build readiness artifact(s) missing: ${missingArtifacts.join(', ')}`);
                }
                const actual = digestArtifacts(requiredArtifacts, 'consume-frontend-build-ready');
                const actualDigests = actual.digests;
                const mismatches = requiredArtifacts.filter((requiredPath) =>
                {
                    const expectedDigest = requiredPath === artifactPath
                        ? marker.distEntry.digest
                        : requiredPath === generatedContractPath
              ? marker.generatedContract.digest
              : requiredPath === stageReceiptPath
                ? marker.stageReceipt.digest
              : requiredPath === frontendDistPath
                ? marker.frontendDist.digest
              : requiredPath === backendWebRootPath
                ? marker.backendWebRoot.digest
              : marker.privacyWasmArtifacts[requiredPath].digest;
                    const expectedRef = requiredPath === artifactPath
                        ? marker.distEntry.artifactRef
                        : requiredPath === generatedContractPath
              ? marker.generatedContract.artifactRef
              : requiredPath === stageReceiptPath
                ? marker.stageReceipt.artifactRef
              : requiredPath === frontendDistPath
                ? marker.frontendDist.artifactRef
              : requiredPath === backendWebRootPath
                ? marker.backendWebRoot.artifactRef
              : marker.privacyWasmArtifacts[requiredPath].artifactRef;
                    return !expectedDigest || actualDigests[requiredPath] !== expectedDigest
            || !expectedRef || actual.refs[requiredPath] !== expectedRef;
                });
                if (mismatches.length > 0)
                {
                    throw new Error(`frontend build readiness digest mismatch: ${mismatches.join(', ')}`);
                }
                return {
                    markerFile: relative(markerFile),
                    markerPublishedAt: marker.publishedAt ?? marker.generatedAt,
                    producerPhysicalBundleId: marker.physicalBundleId,
                    producerStepId: marker.producerStepId,
                    artifacts: requiredArtifacts.map((requiredPath) => ({
                        path: requiredPath,
                        digest: actualDigests[requiredPath],
                        artifactRef: actual.refs[requiredPath]
                    })),
                    stageReceiptIdentity: stageReceipt.identity
                };
            }
            catch (error)
            {
                throw new Error(`invalid run-bound frontend build readiness marker: ${error.message}`, { cause: error });
            }
        }
    });
    return { ...readiness, markerWaitDurationMs: Date.now() - startedAtMs };
}

function resolvedFrontendTestCpuTarget()
{
    const cpuCount = os.availableParallelism?.() ?? os.cpus().length;
    const backendFloor = Math.max(1, Math.floor(
        profile.bundles.find((entry) => entry.id === 'backend-tests')?.minCpuUnits ?? 1
    ));
    const runtimeFloor = Math.max(1, Math.floor(
        profile.bundles.find((entry) => entry.id === 'runtime-browser')?.minCpuUnits ?? 1
    ));
    // Start the transform pool as soon as static prechecks settle. The frontend
    // build releases its CPUs while this long-lived pool is still running, so a
    // machine-derived tail target avoids idling those future slots.
    return Math.max(1, cpuCount - backendFloor - runtimeFloor);
}

function resolvedFrontendEarlyTestCpuTarget()
{
    const currentCpuUnits = Math.max(1, Math.floor(bundleCapacity().cpuUnits));
    return currentCpuUnits >= 3 ? currentCpuUnits - 1 : currentCpuUnits;
}

function resolvedFrontendVitestAdmissionFloor()
{
    const cpuCount = os.availableParallelism?.() ?? os.cpus().length;
    const eventualFrontendCapacity = resolvedFrontendTestCpuTarget();
    // A complete coverage host is expensive to resize after launch. Wait for a
    // machine-derived useful floor instead of starting a future multi-worker
    // host inside the bundle's one-CPU cold-start share. The square-root floor
    // stays portable on small machines while avoiding transform oversubscription.
    return resolveFrontendVitestAdmissionFloor({ cpuCount, eventualFrontendCapacity });
}

async function waitForFrontendTestCapacity(targetCpuUnits, timeoutMs = bundleDeadlineMs())
{
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline)
    {
        const currentCpuUnits = Math.floor(bundleCapacity().cpuUnits);
        if (currentCpuUnits >= targetCpuUnits)
        {
            return;
        }
        await waitForCoordinationPoll(Math.max(10, Math.ceil(1000 / targetCpuUnits)), 'frontend test capacity');
    }
    throw new Error(`timed out waiting for frontend test CPU target: ${targetCpuUnits}`);
}

async function executeRuntimeStepBody(step)
{
    beginPhysicalProducer(step);
    const runtimeOrderCoordination = runtimeOrderBoundaryCollector
      && ['backend-build-ready', 'frontend-build-ready', 'behavior-evidence-ready', 'production-build-artifacts-ready'].includes(step.id);
    const readinessWait = runtimeOrderCoordination
        ? () => runtimeOrderBoundaryCollector.verifyCoordination(step.id)
        : step.id === 'backend-build-ready'
        ? waitForBackendBuildReady
        : step.id === 'backend-tests-ready'
      ? waitForBackendTestsReady
      : step.id === 'frontend-build-ready'
        ? waitForFrontendBuildReady
        : step.id === 'behavior-evidence-ready'
          ? () => waitForCurrentRunMarker('behavior-evidence-ready')
        : step.id === 'production-build-artifacts-ready'
          ? () => waitForCurrentRunMarker('production-build-artifacts-ready')
        : null;
    if (!readinessWait)
    {
        const resetContext = resolveRuntimeResetContext({
            bundleId,
            stepId: step.id,
            catalogLoader: loadRuntimeStateDomainCatalog,
            stepsLoader: runtimeSteps
        });
        const consumedBefore = resetContext
            ? consumeResetReceiptsForStep({
          root,
          catalog: resetContext.catalog,
          steps: resetContext.steps,
          stepId: step.id,
          phase: 'resetBefore',
          runIdentity: runtimeResetIdentity()
        })
            : [];
        let executableStep = step;
        if (step.id === 'bootstrap')
        {
            const runtimeLayout = runtimeOrderBoundaryCollector
                ? prepareRuntimeOrderSessionLayout()
                : prepareProductionRuntimeLayout(productionBuildLayout);
            executableStep = {
                ...step,
                env: {
                    ...productionRuntimeChildEnvironment,
                    ...(runtimeLayout.environment ?? {}),
                    ...(step.env ?? {})
                }
            };
            console.log(
                `[local-production:${bundleId}] prepared mutable runtime roots`
        + ` frontend=${relative(runtimeLayout.runtimeFrontendDist)}`
        + ` backend=${relative(runtimeLayout.runtimeBackendWebRoot)}`
            );
        }
        if (resetContext)
        {
            const originalAfterSuccess = executableStep.afterSuccess;
            executableStep = {
                ...executableStep,
                artifacts: [
                    ...(executableStep.artifacts ?? []),
                    ...consumedBefore.map((entry) => entry.file),
                    ...resetReceiptArtifactsProducedByStep(resetContext.catalog, step.id)
                ],
                afterSuccess: async (result) =>
                {
                    if (typeof originalAfterSuccess === 'function')
                    {
                        await originalAfterSuccess(result);
                    }
                    resetReceiptsProducedByStep({
                        root,
                        catalog: resetContext.catalog,
                        step: executableStep,
                        result,
                        runIdentity: runtimeResetIdentity()
                    });
                }
            };
        }
        const result = await executeStep(executableStep);
        if (step.id === 'bootstrap')
        {
            const namespace = String(process.env.FSUSBLOG_TEST_NAMESPACE ?? '').trim();
            runtimeChildEnvironment = {
                ...readRuntimeEnvironment(root, namespace),
                ...productionRuntimeChildEnvironment,
                ...(runtimeOrderBoundaryCollector
                    ? (() =>
                    {
                        const runtimeRoot = path.join(
                            path.resolve(process.env.FSUSBLOG_RUNTIME_ORDER_SESSION_ROOT),
                            'mutable', 'runtime-layout');
                        const frontend = path.join(runtimeRoot, 'frontend', 'dist');
                        const backend = path.join(runtimeRoot, 'backend', 'wwwroot');
                        return {
                            FSUSBLOG_FRONTEND_DIST_ROOT: frontend,
                            FSUSBLOG_BACKEND_WEBROOT: backend,
                            FSUSBLOG_WEB_ROOT: backend,
                            FSUSBLOG_RETENTION_WEBROOT_DIR: backend,
                            ASPNETCORE_WEBROOT: backend
                        };
                    })()
                    : {})
            };
            console.log(`[local-production:${bundleId}] loaded runtime environment namespace=${namespace}`);
        }
        if (resetContext)
        {
            consumeResetReceiptsForStep({
                root,
                catalog: resetContext.catalog,
                steps: resetContext.steps,
                stepId: step.id,
                phase: 'resetAfter',
                runIdentity: runtimeResetIdentity()
            });
        }
        return result;
    }

    return executeCoordinationStep(step, {
        observation: { readinessMarker: step.id },
        readinessWait,
        successLog: () => `${step.id} run=${schedulerRunId()} validated=true`
    });
}

async function executeRuntimeStep(step)
{
    const observeBoundaries = runtimeOrderBoundaryCollector
      && stepMutatesRuntimeState(runtimeStateAuthority, step.id);
    if (observeBoundaries)
    {
        runtimeOrderBoundaryCollector.beginResetBarriers(step.id);
    }
    const beforeCapture = observeBoundaries
        ? await runtimeOrderBoundaryCollector.capture('before-mutating-step', step.id)
        : null;
    let result;
    if (step.id === 'runtime-state-stable')
    {
        result = await executeRuntimeStepBody(step);
        publishCurrentRunMarker('runtime-state-ready', step.id);
    }
    else
    {
        result = await executeRuntimeStepBody(step);
    }
    if (observeBoundaries)
    {
        const afterCapture = await runtimeOrderBoundaryCollector.capture('after-mutating-step', step.id);
        await runtimeOrderBoundaryCollector.completeResetBarriers({
            producerStepId: step.id,
            processResult: result,
            beforeCapture,
            afterCapture
        });
    }
    return result;
}

async function waitForBenchmarkBuildReady()
{
    const deadline = Date.now() + bundleDeadlineMs();
    while (Date.now() < deadline)
    {
        const markerFile = benchmarkBuildReadyFile();
        if (fs.existsSync(markerFile))
        {
            const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
            const artifactPath = relative(benchmarkDll);
            const artifact = digestArtifacts([artifactPath], 'consume-benchmark-build-ready');
            if (marker?.schema !== 'fsusblog.local-production.benchmark-build-ready.v1'
        || marker.status !== 'success'
        || marker.schedulerRunId !== schedulerRunId()
        || marker.physicalBundleId !== 'backend-tests'
        || marker.producerStepId !== 'backend-benchmark-build'
        || !markerHasCurrentBuildLayout(marker)
        || marker.benchmarkDll?.path !== artifactPath
        || marker.benchmarkDll?.digest !== artifact.digests[artifactPath]
        || marker.benchmarkDll?.contentDigest !== fileContentDigest(benchmarkDll)
        || marker.benchmarkDll?.artifactRef !== artifact.refs[artifactPath])
            {
                throw new Error('run-bound benchmark build readiness is stale or corrupt');
            }
            return marker;
        }
        const failure = producerFailure('backend-tests');
        if (failure)
        {
            throw new Error(`benchmark build producer failed: ${failure}`);
        }
        await waitForCoordinationPoll(resolveMarkerPollIntervalMs(), 'benchmark build readiness');
    }
    throw new Error(`timed out waiting for benchmark build readiness: ${schedulerRunId()}`);
}

async function waitForResidentHandoff()
{
    const inventoryFile = process.env.FSUSBLOG_RESIDENT_LEASE_INVENTORY;
    const handoffFile = process.env.FSUSBLOG_RESIDENT_LEASE_HANDOFF;
    if (!inventoryFile || !handoffFile)
    {
        throw new Error('resident handoff paths were not injected by the scheduler');
    }
    const deadline = Date.now() + bundleDeadlineMs();
    while (Date.now() < deadline)
    {
        if (fs.existsSync(inventoryFile) && fs.existsSync(handoffFile))
        {
            const inventory = readResidentLeaseDocument(inventoryFile);
            validateResidentLeaseInventory(inventory, {
                runId: schedulerRunId(),
                ownerBundleId: 'runtime-browser',
                requiredServiceIds: productionResidentServiceIds,
                sourceState: currentSourceState()
            });
            const consumed = consumeResidentLeaseHandoffFile(handoffFile, {
                inventory,
                consumerBundleId: 'performance-evidence'
            });
            const namespace = String(process.env.FSUSBLOG_TEST_NAMESPACE ?? '').trim();
            runtimeChildEnvironment = {
                ...readRuntimeEnvironment(root, namespace),
                ...productionRuntimeChildEnvironment,
                FSUSBLOG_RESIDENT_LEASE_INVENTORY: inventoryFile,
                FSUSBLOG_RESIDENT_LEASE_HANDOFF: handoffFile,
                FSUSBLOG_RESIDENT_RESERVED_CPU_UNITS: String(inventory.reservation.cpuUnits),
                FSUSBLOG_RESIDENT_RESERVED_MEMORY_GIB: String(inventory.reservation.memoryGiB)
            };
            return consumed;
        }
        const failure = producerFailure('runtime-browser');
        if (failure)
        {
            throw new Error(`resident runtime producer failed: ${failure}`);
        }
        await waitForCoordinationPoll(resolveMarkerPollIntervalMs(), 'resident runtime handoff');
    }
    throw new Error(`timed out waiting for resident runtime handoff: ${schedulerRunId()}`);
}

async function executePerformanceStep(step)
{
    beginPhysicalProducer(step);
    const markerId = {
        'backend-coverage-ready': 'backend-coverage-ready',
        'frontend-coverage-ready': 'frontend-coverage-ready',
        'runtime-state-ready': 'runtime-state-ready',
        'backend-quiet-ready': 'backend-quiet-ready',
        'frontend-quiet-ready': 'frontend-quiet-ready',
        'build-static-quiet-ready': 'build-static-quiet-ready'
    }[step.id];
    const readinessWait = markerId
        ? () => waitForCurrentRunMarker(markerId)
        : step.id === 'frontend-build-ready'
      ? waitForFrontendBuildReady
      : step.id === 'benchmark-build-ready'
        ? waitForBenchmarkBuildReady
        : step.id === 'resident-handoff-ready'
          ? waitForResidentHandoff
          : null;
    if (readinessWait)
    {
        const logFile = path.join(logDir, `${step.id}.log`);
        const startedAtMs = Date.now();
        fs.writeFileSync(logFile, '');
        try
        {
            const readiness = await observeWait(step.id, { readinessMarker: step.id }, readinessWait);
            const finishedAtMs = Date.now();
            fs.writeFileSync(logFile, `${JSON.stringify({ markerId: step.id, validated: true })}\n`);
            const result = { code: 0, signal: null, durationMs: finishedAtMs - startedAtMs, startedAtMs, finishedAtMs, logFile, readiness };
            recordPhysicalProducerResult(step, { ...result, status: 'success', terminalState: 'success' });
            stepResourceMetrics.set(step.id, {
                status: 'not-applicable',
                wallSeconds: result.durationMs / 1000,
                actualCpuSeconds: null,
                grantedCpuSeconds: null,
                coordination: { markerId: step.id, status: 'success' }
            });
            register(step, result);
            return result;
        }
        catch (error)
        {
            const finishedAtMs = Date.now();
            const result = {
                code: 1,
                signal: shutdownController.signal.aborted ? 'cancelled' : null,
                durationMs: finishedAtMs - startedAtMs,
                startedAtMs,
                finishedAtMs,
                logFile
            };
            fs.writeFileSync(logFile, `${JSON.stringify({
                markerId: step.id,
                validated: false,
                error: error instanceof Error ? error.message : String(error)
            })}\n`);
            const terminalState = shutdownController.signal.aborted ? 'cancelled' : 'failed';
            recordPhysicalProducerResult(step, { ...result, status: terminalState, terminalState });
            stepResourceMetrics.set(step.id, {
                status: 'not-applicable',
                wallSeconds: result.durationMs / 1000,
                actualCpuSeconds: null,
                grantedCpuSeconds: null,
                coordination: {
                    markerId: step.id,
                    status: shutdownController.signal.aborted ? 'cancelled' : 'failure',
                    error: error instanceof Error ? error.message : String(error)
                }
            });
            throw new StepTerminalError(
                terminalState,
        shutdownController.signal.aborted ? 'bundle-shutdown' : 'coordination-marker-failed',
        error instanceof Error ? error.message : String(error),
        { cause: error instanceof Error ? error : undefined }
            );
        }
    }
    const result = await executeStep(step);
    return result;
}

async function executeCoordinationStep(step, {
    observation,
    readinessWait,
    successLog
})
{
    const logFile = path.join(logDir, `${step.id}.log`);
    const startedAtMs = Date.now();
    fs.writeFileSync(logFile, '');
    console.log(`[local-production:${bundleId}] start ${step.id} coordination-only`);
    try
    {
        const readiness = await observeWait(step.id, observation, readinessWait);
        const finishedAtMs = Date.now();
        fs.writeFileSync(logFile, `${successLog(readiness)}\n`);
        const result = {
            code: 0,
            signal: null,
            durationMs: finishedAtMs - startedAtMs,
            startedAtMs,
            finishedAtMs,
            logFile,
            readiness
        };
        recordPhysicalProducerResult(step, { ...result, status: 'success', terminalState: 'success' });
        stepResourceMetrics.set(step.id, {
            status: 'not-applicable',
            wallSeconds: result.durationMs / 1000,
            actualCpuSeconds: null,
            grantedCpuSeconds: null,
            coordination: { markerId: step.id, status: 'success' }
        });
        console.log(`[local-production:${bundleId}] done ${step.id} durationMs=${result.durationMs}`);
        register(step, result);
        return result;
    }
    catch (error)
    {
        const finishedAtMs = Date.now();
        const message = error instanceof Error ? error.message : String(error);
        const terminalState = shutdownController.signal.aborted ? 'cancelled' : 'failed';
        fs.writeFileSync(logFile, `${JSON.stringify({
            markerId: step.id,
            validated: false,
            error: message
        })}\n`);
        const result = {
            code: 1,
            signal: shutdownController.signal.aborted ? 'cancelled' : null,
            durationMs: finishedAtMs - startedAtMs,
            startedAtMs,
            finishedAtMs,
            logFile,
            status: terminalState,
            terminalState
        };
        recordPhysicalProducerResult(step, result);
        stepResourceMetrics.set(step.id, {
            status: 'not-applicable',
            wallSeconds: result.durationMs / 1000,
            actualCpuSeconds: null,
            grantedCpuSeconds: null,
            coordination: {
                markerId: step.id,
                status: terminalState,
                error: message
            }
        });
        throw new StepTerminalError(
            terminalState,
      shutdownController.signal.aborted ? 'bundle-shutdown' : 'coordination-marker-failed',
      message,
      { cause: error instanceof Error ? error : undefined }
        );
    }
}

async function executeFrontendStep(step)
{
    beginPhysicalProducer(step);
    if (step.id === 'frontend-build-ready')
    {
        return executeCoordinationStep(step, {
            observation: { readinessMarker: step.id },
            readinessWait: () => waitForFrontendBuildReady(),
            successLog: (readiness) => JSON.stringify({ ...readiness, validated: true })
        });
    }
    if (step.id === 'frontend-early-test-capacity-ready')
    {
        const targetCpuUnits = resolvedFrontendEarlyTestCpuTarget();
        return executeCoordinationStep(step, {
            observation: { capacity: { cpu: true, memory: false } },
            readinessWait: () => waitForFrontendTestCapacity(targetCpuUnits),
            successLog: () => `targetCpuUnits=${targetCpuUnits} validated=true`
        });
    }
    if (step.id === 'backend-production-summary-ready')
    {
        return executeCoordinationStep(step, {
            observation: { readinessMarker: 'backend-production-summary' },
            readinessWait: () => waitForBackendProductionSummaryReady(),
            successLog: () => `${step.id} run=${schedulerRunId()} validated=true`
        });
    }
    return executeRuntimeStep(step);
}

async function runFrontendTests()
{
    const staticManifest = resolveCommandGroup(matrix, 'frontend-static-governance');
    const frontendPackage = JSON.parse(fs.readFileSync(path.join(root, 'src/frontend/package.json'), 'utf8'));
    const staticPlan = planLocalStaticCommands(buildLocalStaticManifest(staticManifest, frontendPackage.scripts));
    const staticEvidence = Object.fromEntries(
        ['blocking-prebuild', 'concurrent', 'postbuild', 'isolated', 'final']
            .map((stage) => [stage, path.join(outDir, `frontend-static-${stage}.json`)])
    );
    const staticTestIds = (entries) => entries.map((entry) => `frontend-static:${entry.id}`);
    const staticStageStep = (stage, options = {}) => commandStep(
        `frontend-static-${stage}`,
        `FSUSBLOG_LOCAL_STATIC_PHASE=${stage} FSUSBLOG_LOCAL_STATIC_EVIDENCE_FILE=${shellQuote(relative(staticEvidence[stage]))} FSUSBLOG_COMMAND_MANIFEST_WORKERS="$FSUSBLOG_STEP_CPU_BUDGET" FSUSBLOG_STATIC_PAYLOAD_BUDGET_MODE=authoritative node tools/test/local-static-governance.mjs`,
        ['frontend-static-governance'],
        {
            ...options,
            artifacts: [
                staticEvidence[stage],
                ...staticPlan[stage].flatMap((entry) => (entry.ownedOutputs ?? []).map(physicalArtifactPath))
            ],
            testIds: staticTestIds(staticPlan[stage])
        }
    );
    // Only checks that validate the actual Vitest admission/configuration inputs
    // form the pre-test barrier. Every other static command enters the settled
    // weighted DAG below with explicit resource ownership from the manifest.
    await executeStep(staticStageStep('blocking-prebuild', {
        resources: { cpuWeight: 1, memoryWeight: 0.5, minCpuUnits: 1 }
    }));
    const step = commandStep('vitest-production-projects',
        'node tools/test/run-frontend-vitest-rolling-shards.mjs', [], {
            dependsOn: ['frontend-early-test-capacity-ready'],
            // run-frontend-vitest-rolling-shards reads the admitted step grant. Do not
            // inject the larger eventual bundle target into a smaller live allocation.
            resources: {
                cpuWeight: 2,
                memoryWeight: 1.5,
                minCpuUnits: resolvedFrontendVitestAdmissionFloor(),
                exclusiveResources: ['frontend-test-results']
            }
        });
    const perfStep = commandStep('vitest-production-perf-isolated',
        'node tools/test/run-frontend-vitest-perf-isolated.mjs', [], {
            dependsOn: ['frontend-build-ready', 'vitest-settled'],
            resources: {
                cpuWeight: 1,
                memoryWeight: 1,
                minCpuUnits: 1,
                exclusiveResources: ['frontend-test-results']
            }
        });
    const frontendDagResults = new Map();
    const frontendSteps = [
        commandStep('frontend-build-ready', ':', [], {
            resources: { coordinationOnly: true }
        }),
        commandStep('frontend-early-test-capacity-ready', ':', [], {
            resources: { coordinationOnly: true }
        }),
        staticStageStep('concurrent', {
            resources: {
                cpuWeight: 1,
                memoryWeight: 0.5,
                minCpuUnits: 1,
                exclusiveResources: ['generated-contracts']
            }
        }),
        // Static governance owns the first early CPU. Once build-static releases
        // capacity, Vitest starts in the remaining slots; its live scheduler grant
        // expands as this static phase settles and additional CPUs become free.
        commandStep('static-governance-concurrent', 'node tools/governance/repository-governance-authority.mjs run application-static-governance', ['static-governance'], {
            dependsOn: ['frontend-build-ready'],
            resources: { cpuWeight: 1, memoryWeight: 0.5, minCpuUnits: 1 }
        }),
        step,
        commandStep(
            'privacy-zk-canonical-receipts',
            'node tools/test/lanes/produce-privacy-zk-prebuild-receipts.mjs',
            [],
            {
                dependsOn: ['frontend-static-concurrent'],
                artifacts: [runOutputRoot
                    ? path.join(runOutputRoot, 'artifacts/privacy-zk-canonical')
                    : path.join(root, '.tmp/security/privacy-zk-canonical')],
                resources: { cpuWeight: 0.25, memoryWeight: 0.25, minCpuUnits: 1 }
            }
        ),
        commandStep('privacy-zk-contract-prebuild', 'tools/test/lanes/privacy-zk-comment-matrix.sh contract-prebuild', [], {
            dependsOn: ['privacy-zk-canonical-receipts'],
            artifacts: [path.join(
                process.env.FSUSBLOG_SECURITY_OUTPUT_ROOT ?? path.join(root, '.tmp/security'),
                'privacy-zk-comment-matrix-stages/contract-prebuild.json')],
            resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 }
        }),
        commandStep('privacy-zk-contract', 'tools/test/lanes/privacy-zk-comment-matrix.sh contract-postbuild', [], {
            dependsOn: ['frontend-build-ready', 'privacy-zk-contract-prebuild'],
            artifacts: [path.join(
                process.env.FSUSBLOG_SECURITY_OUTPUT_ROOT ?? path.join(root, '.tmp/security'),
                'privacy-zk-comment-matrix-stages/contract.json')],
            resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 }
        }),
        staticStageStep('postbuild', {
            dependsOn: ['frontend-build-ready'],
            resources: {
                cpuWeight: 0.5,
                memoryWeight: 0.5,
                minCpuUnits: 1,
                exclusiveResources: ['frontend-dist', 'frontend-static-output']
            }
        }),
        commandStep('vitest-settled', null, [], {
            dependsOn: ['vitest-production-projects'],
            runAfterSettled: true,
            resources: { coordinationOnly: true }
        }),
        perfStep,
        // Retention and the other test-asset checks are content-addressed. The
        // authority executes them only when their declared tests/matrix/coverage
        // inputs or checker/toolchain identity changed.
        commandStep('static-governance-post-vitest', 'node tools/governance/repository-governance-authority.mjs ensure test-asset-governance', ['static-governance'], {
            dependsOn: ['vitest-settled'],
            resources: { cpuWeight: 0.5, memoryWeight: 0.5, minCpuUnits: 1 }
        }),
        commandStep('frontend-coverage-summary',
            'FSUSBLOG_COVERAGE_SKIP_TESTS=1 tools/coverage/collect-frontend-coverage.sh', [], {
                dependsOn: ['vitest-settled'],
                resources: {
                    cpuWeight: 0.5,
                    memoryWeight: 0.5,
                    minCpuUnits: 1,
                    exclusiveResources: ['frontend-test-results', 'frontend-coverage']
                }
            }),
        staticStageStep('isolated', {
            dependsOn: ['vitest-settled'],
            resources: {
                cpuWeight: 0.5,
                memoryWeight: 0.5,
                minCpuUnits: 1,
                exclusiveResources: ['frontend-static-output', 'frontend-render-pressure']
            }
        }),
        commandStep('frontend-static-final-ready', null, [], {
            dependsOn: ['frontend-static-concurrent', 'frontend-static-postbuild', 'frontend-static-isolated'],
            runAfterSettled: true,
            resources: { coordinationOnly: true }
        }),
        staticStageStep('final', {
            dependsOn: ['frontend-static-final-ready'],
            resources: {
                cpuWeight: 0.5,
                memoryWeight: 0.25,
                minCpuUnits: 1,
                exclusiveResources: ['frontend-static-output', 'frontend-render-pressure']
            }
        }),
        commandStep(
            'frontend-static-cross-stack-owner',
            'node tools/test/cross-stack-receipts.mjs owner frontend-static-governance',
            [],
            {
                dependsOn: ['frontend-static-final'],
                resources: { cpuWeight: 0.25, memoryWeight: 0.25, minCpuUnits: 1 }
            }
        ),
        commandStep(
            'frontend-render-structure',
            'tools/test/lanes/frontend-render-structure.sh',
            ['frontend-render-structure'],
            {
                dependsOn: ['frontend-static-final'],
                artifacts: [
                    path.join(process.env.FSUSBLOG_FRONTEND_OUTPUT_ROOT ?? path.join(root, '.tmp/frontend'), 'markdown-render-budget.json'),
                    path.join(process.env.FSUSBLOG_FRONTEND_OUTPUT_ROOT ?? path.join(root, '.tmp/frontend'), 'dom-depth-static.json'),
                    path.join(process.env.FSUSBLOG_FRONTEND_OUTPUT_ROOT ?? path.join(root, '.tmp/frontend'), 'receipts/markdown-render-budget.json'),
                    path.join(process.env.FSUSBLOG_FRONTEND_OUTPUT_ROOT ?? path.join(root, '.tmp/frontend'), 'receipts/dom-depth-static.json'),
                    releaseEvidenceFile('frontend-render-structure-summary.json')
                ],
                resources: {
                    cpuWeight: 0.5,
                    memoryWeight: 0.5,
                    minCpuUnits: 1,
                    exclusiveResources: ['frontend-static-output', 'frontend-render-pressure']
                }
            }
        ),
        commandStep('frontend-tests-join', null, [], {
            dependsOn: [
                'vitest-production-projects',
                'frontend-static-concurrent',
                'static-governance-concurrent',
                'frontend-static-postbuild',
                'frontend-static-isolated',
                'frontend-static-final',
                'frontend-static-cross-stack-owner',
                'frontend-render-structure',
                'static-governance-post-vitest',
                'frontend-coverage-summary',
                'vitest-production-perf-isolated'
            ],
            runAfterSettled: true,
            resources: { coordinationOnly: true }
        })
    ];
    await executeBundleStepDag(
        frontendSteps,
        () => bundleDagCapacityForSteps(frontendSteps),
        async (frontendStep) =>
        {
            const result = await executeFrontendStep(frontendStep);
            if (frontendStep.id === 'frontend-coverage-summary')
            {
                publishCurrentRunMarker('frontend-coverage-ready', frontendStep.id);
            }
            frontendDagResults.set(frontendStep.id, result);
        }
    );
    const result = frontendDagResults.get('vitest-production-projects');
    if (!result)
    {
        throw new Error('vitest-production-projects completed without a result');
    }
    const perfResult = frontendDagResults.get('vitest-production-perf-isolated');
    const markerResult = frontendDagResults.get('frontend-build-ready');
    const vitestSettledResult = frontendDagResults.get('vitest-settled');
    if (!perfResult || !markerResult?.readiness || !vitestSettledResult)
    {
        throw new Error('frontend perf admission evidence is incomplete');
    }
    frontendPerfAdmissionEvidence = {
        schema: 'fsusblog.frontend-perf-admission.v1',
        status: 'success',
        schedulerRunId: schedulerRunId(),
        sourceState: {
            commit: process.env.FSUSBLOG_TEST_SOURCE_COMMIT ?? null,
            worktreeFingerprint: process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT ?? null
        },
        marker: markerResult.readiness,
        mainVitestSettledAtMs: vitestSettledResult.finishedAtMs,
        perfAdmittedAtMs: perfResult.startedAtMs,
        markerWaitDurationMs: markerResult.readiness.markerWaitDurationMs,
        measurementIsolationMode: 'functional-budget-smoke-contention-aware',
        ordinaryRollingHostsSettled: true,
        waitsForBuildStaticSummary: false
    };
    const reports = [
        reportDirectory('vitest', 'production-rolling', 'merged.json'),
        reportDirectory('vitest', 'production-rolling', 'summary.json'),
        reportDirectory('vitest', 'production', 'perf-isolated.json'),
        reportDirectory('vitest', 'production', 'perf-isolated-timing.json')
    ];
    if (reports.some((file) => !fs.existsSync(file)))
    {
        throw new Error('current-run Vitest report is missing');
    }
    const tests = parseVitestReports(reports);
    if (tests.length === 0 || tests.some((entry) => entry.status !== 'passed'))
    {
        throw new Error('Vitest report is empty or contains non-passing tests');
    }
    const summary = coverageDirectory('frontend', 'Summary.json');
    const perfTests = tests.filter((entry) => entry.file.includes('/benchmarks/'));
    const nonPerfTests = tests.filter((entry) => !entry.file.includes('/benchmarks/'));
    if (perfTests.length === 0)
    {
        throw new Error('isolated frontend perf report is empty');
    }
    const byMember = {
        'frontend-unit-shard': nonPerfTests.filter((entry) => entry.file.includes('/unit/')),
        'frontend-property-model-perf': nonPerfTests.filter((entry) => /\/(?:property|model)\//u.test(entry.file)),
        'frontend-fast-summary': nonPerfTests,
        'coverage-frontend': nonPerfTests
    };
    for (const tierId of bundle.members)
    {
        if (['static-governance', 'frontend-static-governance', 'frontend-render-structure'].includes(tierId))
        {
            continue;
        }
        const selected = byMember[tierId] ?? [];
        if (selected.length === 0)
        {
            throw new Error(`${tierId} received no executed Vitest IDs`);
        }
        register({ id: 'vitest-production-projects', members: [tierId] }, result, selected.map((entry) => entry.id), [summary, ...reports]);
        if (['frontend-property-model-perf', 'frontend-fast-summary', 'coverage-frontend'].includes(tierId))
        {
            register({ id: 'vitest-production-perf-isolated', members: [tierId] }, perfResult,
                perfTests.map((entry) => entry.id), [summary, ...reports]);
        }
    }
}

async function run()
{
    validateCorrectnessAttemptMigration(root);
    for (const producerId of productionFreshProducerInventory.bundles[bundleId] ?? [])
    {
        assertCorrectnessAttemptExecutionOwner(
            `physical:${bundleId}:${producerId}`,
            'tools/test/bundles/run-bundle.mjs',
            root
        );
    }
    if (finalizeExisting)
    {
        loadExistingMemberExecutionReceipts();
    }
    else if (bundleId === 'backend-tests')
    {
        await runBackendTests();
    }
    else if (bundleId === 'frontend-tests')
    {
        await runFrontendTests();
    }
    else if (bundleId === 'build-static')
    {
        await executeBundleStepDag(buildStaticSteps(), bundleDagCapacity, async (step) =>
        {
            try
            {
                const result = await executeRuntimeStepBody(step);
                if (step.id === 'sync-static-assets')
                {
                    publishFrontendBuildReady();
                }
                return result;
            }
            catch (error)
            {
                if (['frontend-build', 'sync-static-assets'].includes(step.id))
                {
                    publishFrontendBuildTerminal('failure', `${step.id}: ${error instanceof Error ? error.message : String(error)}`);
                }
                throw error;
            }
        });
    }
    else
    {
        const canonicalSteps = bundleId === 'runtime-browser' ? runtimeSteps() : performanceSteps();
        runtimeScheduleControl = bundleId === 'runtime-browser'
            ? resolveRuntimeScheduleControl(canonicalSteps)
            : null;
        const steps = runtimeScheduleControl
            ? orderStepsByPlan(canonicalSteps, runtimeScheduleControl.plan)
            : canonicalSteps;
        const actualStepOrder = [];
        if (runtimeOrderBoundaryCollector)
        {
            prepareRuntimeOrderSessionLayout();
            await runtimeOrderBoundaryCollector.capture('before-runtime');
        }
        await executeBundleStepDag(
            steps,
            () => bundleDagCapacityForSteps(steps),
      bundleId === 'runtime-browser'
          ? async (step) =>
          {
              actualStepOrder.push(step.id);
              return executeRuntimeStep(step);
          }
          : executePerformanceStep
        );
        const runtimeBoundaryEvidence = runtimeOrderBoundaryCollector
            ? await (async () =>
            {
                await runtimeOrderBoundaryCollector.capture('after-runtime');
                return runtimeOrderBoundaryCollector.finish();
            })()
            : { captures: [], resetReceipts: [] };
        const runtimeBoundaryCaptures = runtimeBoundaryEvidence.captures;
        if (runtimeScheduleControl)
        {
            if (JSON.stringify(actualStepOrder) !== JSON.stringify(runtimeScheduleControl.plan.orderedStepIds))
            {
                throw new Error('explicit runtime schedule planned/actual order mismatch');
            }
            runtimeScheduleExecution = {
                schema: 'fsusblog.runtime-schedule-execution.v1',
                planId: runtimeScheduleControl.plan.planId,
                planDigest: runtimeScheduleControl.plan.contentDigest,
                sessionId: runtimeScheduleControl.sessionReceipt.identity.sessionId,
                concurrencyCap: runtimeScheduleControl.plan.concurrencyCap,
                actualStepOrder,
                boundarySnapshotCount: runtimeBoundaryCaptures.length
            };
            if (runtimeOrderResultFile)
            {
                const overlaps = [];
                const executed = [...stepExecutionResults.entries()]
                    .filter(([, result]) => Number.isFinite(result?.startedAtMs) && Number.isFinite(result?.finishedAtMs));
                for (let leftIndex = 0; leftIndex < executed.length; leftIndex += 1)
                {
                    for (let rightIndex = leftIndex + 1; rightIndex < executed.length; rightIndex += 1)
                    {
                        const [leftId, left] = executed[leftIndex];
                        const [rightId, right] = executed[rightIndex];
                        if (Math.max(left.startedAtMs, right.startedAtMs) >= Math.min(left.finishedAtMs, right.finishedAtMs))
                        {
                            continue;
                        }
                        const evaluation = runtimeStateConflictPolicy.evaluate(leftId, rightId);
                        overlaps.push({
                            leftStepId: leftId,
                            rightStepId: rightId,
                            provenNonConflicting: evaluation.conflict === false,
                            catalogDigest: runtimeStateAuthority.catalogDigest
                        });
                    }
                }
                const executedAssertionIds = [...new Set(
                    [...memberEvidence.values()].flatMap((evidence) => evidence.testIds)
                )].sort();
                const outcomes = Object.fromEntries(Object.entries(schedulerTerminalReceipts)
                    .sort(([left], [right]) => left.localeCompare(right))
                    .map(([stepId, receipt]) => [stepId, {
                        terminalState: receipt.terminalState,
                        reasonCode: receipt.reasonCode,
                        dependencyOutcomes: receipt.dependencyOutcomes
                    }]));
                const postconditions = Object.fromEntries(actualStepOrder.map((stepId) => [
                    stepId,
                    {
                        declared: runtimeStateAuthority.steps[stepId]?.postconditions ?? [],
                        status: schedulerTerminalReceipts[stepId]?.terminalState === 'success' ? 'satisfied' : 'failed'
                    }
                ]));
                const afterRuntime = runtimeBoundaryCaptures.find((capture) => (
                    capture.snapshot.boundary === 'after-runtime'
                ));
                if (!afterRuntime)
                {
                    throw new Error('production runtime-order execution lacks after-runtime snapshot');
                }
                const document = {
                    schema: 'fsusblog.production-runtime-order-execution.v1',
                    status: 'success',
                    identity: runtimeScheduleControl.sessionReceipt.identity,
                    planId: runtimeScheduleControl.plan.planId,
                    planDigest: runtimeScheduleControl.plan.contentDigest,
                    executedStepIds: actualStepOrder,
                    executedAssertionIds,
                    outcomes,
                    postconditions,
                    terminalClass: 'success',
                    boundarySnapshots: runtimeBoundaryCaptures,
                    finalSnapshot: afterRuntime.snapshot,
                    finalFragments: afterRuntime.fragments,
                    resetReceipts: runtimeBoundaryEvidence.resetReceipts,
                    processRefs: executed.map(([stepId, result]) => ({
                        stepId,
                        logFile: relative(result.logFile),
                        logEvidenceDigest: result.logEvidence?.contentDigest ?? null
                    })),
                    lifecycleRefs: [runtimeScheduleControl.sessionReceiptFile],
                    overlaps,
                    attemptFailures: []
                };
                const absoluteResultFile = path.resolve(runtimeOrderResultFile);
                if (!absoluteResultFile.startsWith(`${path.resolve(process.env.FSUSBLOG_RUNTIME_ORDER_SESSION_ROOT)}${path.sep}`))
                {
                    throw new Error('runtime-order execution result escapes the session-owned root');
                }
                fs.mkdirSync(path.dirname(absoluteResultFile), { recursive: true, mode: 0o700 });
                fs.writeFileSync(absoluteResultFile, `${JSON.stringify(document, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
            }
        }
    }

    if (!finalizeExisting)
    {
        writePhysicalProducerReceipts();
        writeMemberExecutionReceipts();
    }
    bindMatrixRuntimeArtifacts();
    artifactDigestTable.registerConsumers(Object.fromEntries(
        [...memberEvidence.entries()].map(([tierId, evidence]) => [tierId, evidence.artifactRefs])));
    if (bundleId === 'performance-evidence')
    {
        const currentInvocationDurationMs = Date.now() - startedAt;
        const steps = performanceSteps().map(({ id, evidencePhase }) =>
        {
            const result = stepExecutionResults.get(id);
            if (!result)
            {
                throw new Error(`performance deadline evidence is missing step result: ${id}`);
            }
            return {
                id,
                evidencePhase,
                status: result.status,
                durationMs: result.durationMs,
                startedAtMs: result.startedAtMs,
                finishedAtMs: result.finishedAtMs
            };
        });
        const mixedStepDurationMs = steps.find((step) => step.id === 'mixed-performance-window')?.durationMs;
        const mixedSummaryFile = path.join(
            process.env.FSUSBLOG_PERFORMANCE_OUTPUT_ROOT ?? path.join(root, '.tmp/perf'),
            'mixed-window',
            'summary.json');
        const mixedSummaryDurationMs = fs.existsSync(mixedSummaryFile)
            ? Number(JSON.parse(fs.readFileSync(mixedSummaryFile, 'utf8')).elapsedMs)
            : 0;
        const mixedDurationMs = Math.max(mixedStepDurationMs, mixedSummaryDurationMs);
        const timedMeasurementIds = new Set(steps
            .filter((step) => step.evidencePhase === 'measurement').map((step) => step.id));
        const noiseOverlaps = steps.filter((step) => ['preparation', 'post-measurement'].includes(step.evidencePhase))
            .flatMap((noise) => steps.filter((step) => step.evidencePhase === 'measurement'
        && noise.startedAtMs < step.finishedAtMs && step.startedAtMs < noise.finishedAtMs)
                .map((measurement) => ({ noiseStepId: noise.id, measurementStepId: measurement.id })));
        if (noiseOverlaps.length > 0)
        {
            throw new Error(`timed measurement overlapped non-measurement work: ${JSON.stringify(noiseOverlaps)}`);
        }
        const measuredOtherSerialMs = steps
            .filter((step) => timedMeasurementIds.has(step.id) && step.id !== 'mixed-performance-window')
            .reduce((total, step) => total + step.durationMs, 0);
        const bundleDurationMs = measuredOtherSerialMs + mixedDurationMs;
        performanceDeadlineEvidence = {
            schema: 'fsusblog.performance-deadline-evidence.v2',
            status: 'sufficient',
            schedulerRunId: schedulerRunId(),
            sourceState: currentSourceState(),
            candidateBudgetMs: bundleDeadlineMs(),
            invocationDurationMs: currentInvocationDurationMs,
            bundleDurationMs,
            coordinationWaitMs: steps.filter((step) => step.evidencePhase === 'coordination')
                .reduce((total, step) => total + step.durationMs, 0),
            preparationWorkMs: steps.filter((step) => step.evidencePhase === 'preparation')
                .reduce((total, step) => total + step.durationMs, 0),
            postMeasurementWorkMs: steps.filter((step) => step.evidencePhase === 'post-measurement')
                .reduce((total, step) => total + step.durationMs, 0),
            measurementIsolation: { status: 'isolated', noiseOverlaps },
            mixedWindow: {
                stepId: 'mixed-performance-window',
                minimumDurationMs: performanceMixedWindowFloorMs,
                measuredDurationMs: mixedDurationMs
            },
            measuredOtherSerialMs,
            requiredBudgetMs: performanceMixedWindowFloorMs + measuredOtherSerialMs,
            steps,
            generatedAt: new Date().toISOString()
        };
        const deadlineErrors = validatePerformanceDeadlineEvidence(performanceDeadlineEvidence, {
            expectedRunId: schedulerRunId(),
            expectedSourceState: currentSourceState()
        });
        if (deadlineErrors.length > 0)
        {
            throw new Error(`performance deadline evidence invalid: ${deadlineErrors.join('; ')}`);
        }
        const deadlineFile = path.join(outDir, 'deadline-evidence.json');
        fs.writeFileSync(deadlineFile, `${JSON.stringify(performanceDeadlineEvidence, null, 2)}\n`);
    }
    const members = Object.fromEntries([...memberEvidence.entries()].map(([tierId, evidence]) => [tierId, {
        ...evidence,
        testIds: [...new Set(evidence.testIds)].sort(),
        artifactDigests: Object.fromEntries(Object.entries(evidence.artifactDigests).sort()),
        artifactRefs: Object.fromEntries(Object.entries(evidence.artifactRefs).sort())
    }]));
    for (const [tierId, evidence] of Object.entries(members))
    {
        if (evidence.testIds.length === 0 || Object.keys(evidence.artifactDigests).length === 0
      || Object.keys(evidence.artifactRefs).length !== Object.keys(evidence.artifactDigests).length)
        {
            throw new Error(`${tierId} has no executed test IDs or complete artifact refs`);
        }
    }
    const resourceUtilization = finalizeBundleResourceUtilization('complete');
    const summary = {
        schema: 'fsusblog.local-production.bundle.v1',
        physicalBundleId: bundleId,
        executionSource: process.env.FSUSBLOG_TEST_EXECUTION_SOURCE === 'resume' ? 'resume' : 'fresh',
        status: 'success',
        schedulerRunId: process.env.FSUSBLOG_TEST_RUN_ID ?? null,
        runToken: randomUUID(),
        durationMs: Date.now() - startedAt,
        resourceUtilization,
        ...(frontendPerfAdmissionEvidence ? { frontendPerfAdmission: frontendPerfAdmissionEvidence } : {}),
        ...(performanceDeadlineEvidence ? { deadlineEvidence: performanceDeadlineEvidence } : {}),
        schedulerTerminalReceipts,
        schedulerTerminalReceiptIds: Object.keys(schedulerTerminalReceipts),
        schedulerTerminalReceiptRequired: true,
        ...(runtimeScheduleExecution ? { runtimeScheduleExecution } : {}),
        members,
        generatedAt: new Date().toISOString()
    };
    writeBundleSummaryAtomically(summaryFile, summary);
    // fs.renameSync(temporary, summaryFile) occurs inside writeBundleSummaryAtomically.
    if (!finalizeExisting)
    {
        const quietMarker = {
            'backend-tests': ['backend-quiet-ready', 'backend-tests-quiet'],
            'frontend-tests': ['frontend-quiet-ready', 'frontend-tests-quiet'],
            'build-static': ['build-static-quiet-ready', 'build-static-quiet']
        }[bundleId];
        if (quietMarker)
        {
            publishCurrentRunMarker(...quietMarker);
        }
    }
    console.log(`[local-production:${bundleId}] summary=${relative(summaryFile)} members=${Object.keys(members).length}`);
}

function finalizeBundleResourceUtilization(status, error = null)
{
    if (finalizedResourceUtilization)
    {
        if (status === 'partial' && finalizedResourceUtilization.status === 'complete')
        {
            finalizedResourceUtilization.status = 'partial';
            finalizedResourceUtilization.incomplete = true;
            finalizedResourceUtilization.failure = error ? (error instanceof Error ? error.message : String(error)) : 'bundle incomplete';
            finalizedResourceUtilization.finishedAtMs = Date.now();
            finalizedResourceUtilization.generatedAt = new Date().toISOString();
            const file = path.join(outDir, 'resource-utilization.json');
            const temporary = `${file}.next-${process.pid}`;
            fs.writeFileSync(temporary, `${JSON.stringify(finalizedResourceUtilization, null, 2)}\n`);
            fs.renameSync(temporary, file);
        }
        return finalizedResourceUtilization;
    }
    const waits = waitLedger.finish();
    const steps = Object.fromEntries([...stepResourceMetrics.entries()].sort(([left], [right]) => left.localeCompare(right)));
    const values = Object.values(steps);
    const sum = (key) =>
    {
        const measured = values.map((entry) => Number(entry?.[key])).filter(Number.isFinite);
        return measured.length ? measured.reduce((total, value) => total + value, 0) : null;
    };
    const executableValues = values.filter((entry) => entry?.status !== 'not-applicable');
    const sumComplete = (key) => executableValues.length > 0
    && executableValues.every((entry) => Number.isFinite(Number(entry?.[key])))
        ? executableValues.reduce((total, entry) => total + Number(entry[key]), 0)
        : null;
    const actualCpuSeconds = sum('actualCpuSeconds');
    const grantedCpuSeconds = sumComplete('grantedCpuSeconds');
    const cpuUserSeconds = sum('cpuUserSeconds');
    const cpuSystemSeconds = sum('cpuSystemSeconds');
    const wallSeconds = (Date.now() - startedAt) / 1000;
    const averageRssNumerator = values.reduce((total, entry) =>
    {
        const rss = Number(entry?.averageRssBytes);
        const wall = Number(entry?.wallSeconds);
        return Number.isFinite(rss) && Number.isFinite(wall) ? total + rss * wall : total;
    }, 0);
    finalizedResourceUtilization = {
        schema: 'fsusblog.production.bundle-resource-utilization.v1',
        status,
        incomplete: status !== 'complete',
        schedulerRunId: schedulerRunId(),
        sourceState: {
            commit: process.env.FSUSBLOG_TEST_SOURCE_COMMIT ?? null,
            worktreeFingerprint: process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT ?? null
        },
        physicalBundleId: bundleId,
        startedAtMs: startedAt,
        finishedAtMs: Date.now(),
        wallSeconds,
        cpuUserSeconds,
        cpuSystemSeconds,
        actualCpuSeconds,
        grantedCpuSeconds,
        grantedMemoryGiBSeconds: sumComplete('grantedMemoryGiBSeconds'),
        cpuGrantEfficiency: actualCpuSeconds === null || grantedCpuSeconds === null || grantedCpuSeconds <= 0
            ? null : actualCpuSeconds / grantedCpuSeconds,
        peakRssBytes: values.map((entry) => Number(entry?.peakRssBytes)).filter(Number.isFinite).reduce((peak, value) => Math.max(peak, value), 0) || null,
        averageRssBytes: averageRssNumerator > 0 && wallSeconds > 0 ? averageRssNumerator / wallSeconds : null,
        readBytes: sum('readBytes'),
        writeBytes: sum('writeBytes'),
        voluntaryContextSwitches: sum('voluntaryContextSwitches'),
        involuntaryContextSwitches: sum('involuntaryContextSwitches'),
        processSpawnCount: sum('processSpawnCount'),
        waits,
        steps,
        docker: collectDockerResourceEvidence(),
        failure: error ? (error instanceof Error ? error.message : String(error)) : null,
        generatedAt: new Date().toISOString()
    };
    const file = path.join(outDir, 'resource-utilization.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.next-${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(finalizedResourceUtilization, null, 2)}\n`);
    fs.renameSync(temporary, file);
    return finalizedResourceUtilization;
}

function collectDockerResourceEvidence()
{
    const runId = process.env.FSUSBLOG_TEST_RUN_ID ?? '';
    const discovered = spawnSync('docker', [
        'ps', '-aq',
        '--filter', `label=io.fsusblog.test.run-id=${runId}`,
        '--filter', `label=io.fsusblog.test.bundle-id=${bundleId}`
    ], { cwd: root, encoding: 'utf8', timeout: 5000 });
    if (discovered.error || discovered.status !== 0)
    {
        return { status: 'unavailable', reason: discovered.error?.message ?? discovered.stderr?.trim() ?? `docker-exit-${discovered.status}`, containers: [] };
    }
    const identities = new Set(discovered.stdout.split(/\s+/u).filter(Boolean));
    for (const name of [
        runtimeChildEnvironment.FSUSBLOG_POSTGRES_CONTAINER_NAME,
        runtimeChildEnvironment.FSUSBLOG_REDIS_CONTAINER_NAME
    ])
    {
        if (name)
        {
            identities.add(name);
        }
    }
    const containers = [];
    for (const identity of identities)
    {
        const inspected = spawnSync('docker', ['inspect', identity], { cwd: root, encoding: 'utf8', timeout: 5000 });
        if (inspected.status !== 0)
        {
            continue;
        }
        const item = JSON.parse(inspected.stdout)?.[0];
        const labels = item?.Config?.Labels ?? {};
        const stepId = labels['io.fsusblog.test.step-id'] ?? null;
        const parentExpected = stepId ? stepEffectiveLimits.get(stepId) : null;
        const labeledCpuUnits = Number(labels['io.fsusblog.test.cpu-units']);
        const labeledMemoryHigh = Number(labels['io.fsusblog.test.memory-high-bytes']);
        const labeledMemoryMax = Number(labels['io.fsusblog.test.memory-max-bytes']);
        const labeledPidsMax = Number(labels['io.fsusblog.test.pids-max']);
        const expected = [labeledCpuUnits, labeledMemoryHigh, labeledMemoryMax, labeledPidsMax]
      .every((value) => Number.isFinite(value) && value > 0)
            ? {
          cpuUnits: labeledCpuUnits,
          memoryHighBytes: labeledMemoryHigh,
          memoryMaxBytes: labeledMemoryMax,
          pidsMax: labeledPidsMax
        }
            : parentExpected;
        const effective = {
            nanoCpus: item?.HostConfig?.NanoCpus ?? null,
            cpuQuota: item?.HostConfig?.CpuQuota ?? null,
            cpuPeriod: item?.HostConfig?.CpuPeriod ?? null,
            memoryBytes: item?.HostConfig?.Memory ?? null,
            memoryReservationBytes: item?.HostConfig?.MemoryReservation ?? null,
            pidsLimit: item?.HostConfig?.PidsLimit ?? null
        };
        containers.push({
            id: item?.Id ?? identity,
            name: String(item?.Name ?? '').replace(/^\//u, ''),
            labels,
            effectiveLimits: effective,
            consistency: expected ? {
        status: Number(effective.nanoCpus) === Math.round(expected.cpuUnits * 1e9)
          && Number(effective.memoryBytes) === expected.memoryMaxBytes
          && Number(effective.memoryReservationBytes) === expected.memoryHighBytes
          && Number(effective.pidsLimit) === expected.pidsMax
          ? 'consistent' : 'mismatch',
        expected: {
          nanoCpus: Math.round(expected.cpuUnits * 1e9),
          memoryBytes: expected.memoryMaxBytes,
          memoryReservationBytes: expected.memoryHighBytes,
          pidsLimit: expected.pidsMax
        }
      } : { status: 'unavailable', reason: 'container-step-binding-missing' }
        });
    }
    return { status: 'measured', containers };
}

run().catch((error) =>
{
    const failureMessage = error instanceof Error ? error.message : String(error);
    console.error(`[local-production:${bundleId}] ${failureMessage}`);
    const finalizerBefore = productionFreshLayout && !finalizeExisting
        ? captureProductionFreshOutputInventory(productionFreshLayout)
        : null;
    try
    {
        const resourceUtilization = finalizeBundleResourceUtilization('partial', error);
        const partialSummary = {
            schema: 'fsusblog.local-production.bundle.v1',
            physicalBundleId: bundleId,
            status: 'partial',
            schedulerRunId: process.env.FSUSBLOG_TEST_RUN_ID ?? null,
            durationMs: Date.now() - startedAt,
            resourceUtilization,
            failure: {
                message: failureMessage,
                terminalState: error?.terminalState ?? 'failed',
                reasonCode: error?.reasonCode ?? 'bundle-failure'
            },
            schedulerTerminalReceipts,
            schedulerTerminalReceiptIds: Object.keys(schedulerTerminalReceipts),
            schedulerTerminalReceiptRequired: true,
            generatedAt: new Date().toISOString()
        };
        writeBundleSummaryAtomically(summaryFile, partialSummary);
        if (!finalizeExisting)
        {
            writePhysicalProducerReceipts({
                status: 'partial',
                failure: error,
                finalizerBefore
            });
        }
    }
    catch (finalizationError)
    {
        console.error(
            `[local-production:${bundleId}] failure finalization: ${
        finalizationError instanceof Error ? finalizationError.message : String(finalizationError)
            }`
        );
    }
    if (shutdownPromise)
    {
        return;
    }
    process.exit(1);
});
