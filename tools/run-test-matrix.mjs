#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
    behaviorDocAdmissionTierId,
    defaultBehaviorDocAdmissionReceipt,
    readBehaviorDocStaticAdmissionReceipt
} from './docs/behavior-doc-static-admission.mjs';
import { sealSourceIdentity } from './fact-extractors/identity.mjs';
import { requireCleanAttemptConsumerAdmission } from './release/browser-release-clean-attempt-consumers.mjs';
import { readPreparedBehaviorDocNuget } from './test/behavior-doc-nuget-preparation.mjs';
import { validateCorrectnessAttemptMigration } from './test/correctness-attempt-migration.mjs';
import { validateCurrentRunEvidenceContext } from './test/evidence-location-contract.mjs';
import {
    loadExecutionNetworkPolicy,
    validateExecutionNetworkPolicy
} from './test/execution-envelope-network.mjs';
import {
    loadExecutionServiceCatalog,
    validateExecutionServiceCatalog
} from './test/execution-envelope-services.mjs';
import { loadPhysicalExecutionProcessPolicy } from './test/physical-execution-process-tree.mjs';
import { availableMemoryGiB } from './test/system-memory.mjs';
import {
    buildAggregatePlan as buildAggregateReachabilityPlan,
    buildReceiptPlan as buildReceiptReachabilityPlan
} from './test-matrix/aggregate-plan.mjs';
import { createArtifactDigestTable } from './test-matrix/artifact-digest-table.mjs';
import {
    validateBehaviorDocStaticAdmissionMatrix
} from './test-matrix/behavior-doc-static-admission-contract.mjs';
import {
    applyCorrectnessBudgetPolicy,
    bindBudgetPolicy,
    correctnessBudgetPolicyDigest,
    loadCorrectnessBudgetPolicy,
    validateCorrectnessBudgetPolicy
} from './test-matrix/correctness-budget-policy.mjs';
import {
    cleanupOrphanDotnetBuildServers,
    discoverOrphanDotnetBuildServers,
    dotnetBuildServerInventory
} from './test-matrix/dotnet-build-server-cleanup.mjs';
import {
    loadExecutionEnvelopeApplicability,
    loadExecutionEnvelopePolicy,
    validateExecutionEnvelopeContracts
} from './test-matrix/execution-envelope-policy.mjs';
import { validateFixtureProfileMatrix } from './test-matrix/fixture-profile-contract.mjs';
import { cleanLocalProductionOutputs, dockerRootDirectory } from './test-matrix/fresh-production.mjs';
import {
    buildLocalProfileProjection,
    createLocalBundleTiers,
    localBundleSummaryPath,
    localProfileSystemResources,
    resolveLocalProfileResources,
    validateLocalBundleSummary,
    validateLocalProfileRunSummary,
    validateLocalProfiles,
    projectLocalBootstrapFixtureProfile,
    projectLocalNonResidentServiceRequirements
} from './test-matrix/local-profile.mjs';
import {
    appendFreshRuntimeCleanupFailure,
    assertFreshRuntimeCleanupReceipt,
    writeFreshRuntimeCleanupReceipt
} from './test-matrix/local-runtime-cleanup.mjs';
import { runLocalWorkflow } from './test-matrix/local-workflow-runner.mjs';
import { parseMatrix } from './test-matrix/parse-matrix.mjs';
import { readGitChangedPaths, selectAffectedPrTiers, validateImpactDeclarations, validatePrImpactPlanBinding, prImpactCallerContext, prImpactConsumerEnvironment, effectivePrExecutionStage } from './test-matrix/pr-impact-plan.mjs';
import {
    bindProductionBuildLayoutSource,
    markProductionBuildServiceCreationAttempt,
    productionBuildEnvironment,
    registerProductionBuildCompiler,
    retainProductionBuildResourceBoundary,
    retainProductionBuildServiceContainment,
    settleProductionBuildResidentService,
    transferProductionBuildResidentService
} from './test-matrix/production-build-layout.mjs';
import { runProductionBuildLifecycle } from './test-matrix/production-build-lifecycle.mjs';
import { acquireProductionCapacityReservation } from './test-matrix/production-capacity-reservation.mjs';
import {
    buildProductionDiskDemandPlan,
    bindBehaviorDocNugetDiskDemand,
    defaultProductionDiskRoots,
    readProductionDiskDemandCatalog
} from './test-matrix/production-disk-demand.mjs';
import { inspectProductionFreshCacheTransactions } from './test-matrix/production-fresh-cache-transaction.mjs';
import { acquireProductionFreshExclusiveLease } from './test-matrix/production-fresh-exclusive-lease.mjs';
import {
    assertProductionFreshProducerConfiguration,
    beginProductionFreshForbiddenOutputObservation,
    captureProductionFreshOutputInventory,
    createProductionFreshOutputRoot,
    finalizeProductionFreshAttempt,
    finishProductionFreshForbiddenOutputObservation,
    isProductionFreshRuntimeCleanupOutput,
    productionFreshGovernanceOutputs,
    productionFreshOutputEnvironment,
    productionFreshSchedulerRunDirectoryPreservation,
    resolveProductionFreshSchedulerProducerIds,
    resolveProductionFreshOutputAttempt,
    verifyProducerOutputDelta,
    verifyProductionFreshReceiptInventory
} from './test-matrix/production-fresh-run-bound-outputs.mjs';
import {
    bindFreshRuntimeCleanupReceipt,
    executeProductionFreshPreflight,
    recordProductionFreshFailure,
    runProductionFreshRuntimeCleanupPhase,
    runtimeCleanupReceiptReference
} from './test-matrix/production-fresh-runtime-evidence.mjs';
import { validateEvidenceExecutionDeclaration, validateReleaseDomainMatrix } from './test-matrix/projection-declaration.mjs';
import { runProtectedBehaviorDocAdmission } from './test-matrix/protected-behavior-doc-admission.mjs';
import { buildReleaseFinalizerPlan } from './test-matrix/release-final-evidence-contract.mjs';
import {
    validateReleaseFinalStaticBoundary
} from './test-matrix/release-final-static-boundary.mjs';
import {
    loadReleaseReliabilityCatalog,
    validateReleaseReliabilitySchedulerMatrix
} from './test-matrix/release-reliability-scheduler-projection.mjs';
import {
    createRequiredEvidenceDependencies,
    recordRequiredEvidenceExecution,
    requiredEvidencePlanDigest,
    requiredEvidencePlanIdentity
} from './test-matrix/required-evidence-dependencies.mjs';
import {
    measureResourceCollectorOverhead,
    writeResourceUtilizationEvidence
} from './test-matrix/resource-utilization.mjs';
import { validateRuntimeStateDomainCatalog } from './test-matrix/runtime-state-domain-catalog.mjs';
import {
    aggregateArtifactPathExists,
    applySupersedes,
    attachCheckpointEvidence,
    collectSchedulerSourceState,
    createCurrentRunBehaviorDocAdmissionBinding,
    createCurrentRunPreexecutedTierBinding,
    createRunId,
    findLatestRunId,
    isProjectionOnlyCheckpointFailure,
    markCheckpointWallClockTimeout,
    recordCheckpointFailure,
    recordCheckpointProductionCapacityReservation,
    recordCheckpointRuntimeCleanup,
    resumeCheckpointEvidence,
    runDag,
    snapshotGitWorktree,
    snapshotSourceState,
    tierResourceUnits,
    validateSupersedesRules
} from './test-matrix/scheduler.mjs';
import { topologyEnvironmentForTier, validateTierTopology } from './test-matrix/topology.mjs';
import {
    applySealedFixtureProfileEnvironment,
    sealMatrixFixtureProfile, validateFixtureCatalogs
} from './testing/fixture-catalog.mjs';
import { parseWorkflowJobNeeds } from './yaml/workflow-structure.mjs';

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const matrixFile = process.env.FSUSBLOG_MATRIX_FILE
    ? path.resolve(root, process.env.FSUSBLOG_MATRIX_FILE)
    : path.join(root, 'tests/matrix.yml');
const schemaFile = path.join(root, 'tests/matrix.schema.json');
const schemaValidatorFile = path.join(root, 'tools/test-matrix/schema-validator/validate.mjs');
const coverageRegistryFile = process.env.FSUSBLOG_COVERAGE_REGISTRY_FILE
    ? path.resolve(root, process.env.FSUSBLOG_COVERAGE_REGISTRY_FILE)
    : path.join(root, 'tests/coverage-registry.json');
const preflightLogFile = path.join(root, '.tmp/gate-logs/preflight.json');
const prSmartGateSummaryFile = path.join(root, '.tmp/release-evidence/pr-smart-gate-summary.json');
const summaryStages = ['setup', 'restore', 'install', 'bootstrap', 'test', 'artifact', 'summary'];
const coverageAssertionTypes = ['static', 'unit', 'integration', 'contract', 'runtime', 'browser', 'perf', 'fuzz', 'mutation'];
const runtimeLikeCoverageAssertionTypes = new Set(['runtime', 'browser', 'perf', 'fuzz', 'mutation']);
const coverageTemplateDescriptionPattern = /^Coverage contract for\b/i;
const genericCoverageMinimumRequirementPattern = /^(static|unit|integration|contract|runtime|browser|perf|fuzz|mutation) evidence declared by tier\b/i;
const cadenceValues = ['pr', 'push', 'nightly', 'release-manual'];
const requiredForValues = ['fast', 'production', 'release-final', 'none'];
const smartGateModeValues = ['always', 'conditional', 'full-only'];
const retentionClassValues = ['must-keep', 'conditional', 'redundant-candidate', 'obsolete'];
const evidenceClassValues = ['correctness', 'browser-contract', 'diagnostic'];
const releaseBrowserAuthorityTierIds = new Set(['browser-contract', 'production-xss-release']);
const executionVariantValues = ['ordinary', 'coverage', 'property', 'model', 'performance', 'runtime'];
const uxViewportTierIds = new Set(['ux-viewport-smoke', 'ux-viewport-visual', 'ux-viewport-boundaries']);
const aliases = new Map([
    ['coverage', 'coverage-gate'],
    ['integrity-proof', 'integrity-proof-verification'],
    ['frontend-fast', 'frontend-fast-summary'],
    ['backend-qps-runtime', 'runtime-cache-evidence'],
    ['endpoint-depth-matrix-generate', 'endpoint-depth'],
    ['endpoint-depth-runtime-smoke', 'endpoint-depth'],
    ['endpoint-depth-runtime-full', 'endpoint-depth']
]);
const frontendFastSplitIds = [
    'frontend-build',
    'frontend-unit-shard',
    'frontend-property-model-perf',
    'frontend-runtime-contracts',
    'frontend-static-governance',
    'frontend-fast-summary'
];
const frontendFastExecutableSplitIds = frontendFastSplitIds.filter((tierId) => tierId !== 'frontend-fast-summary');
const summaryInvocationId = `${process.env.GITHUB_RUN_ID ?? 'local'}-${process.env.GITHUB_RUN_ATTEMPT ?? '0'}-${process.pid}-${Date.now()}`;
const ciSummaryAuthorityId = process.env.GITHUB_RUN_ID && process.env.GITHUB_JOB
    ? `gha-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT ?? '1'}-${process.env.GITHUB_JOB}`
    : null;
let activeProductionFreshOutputRoot = null;

function isReleaseReliabilityScenarioCommand(command)
{
    const tokens = String(command ?? '').trim().split(/\s+/u)
        .map((token) => token.replaceAll(/['"]/gu, ''));
    return tokens.some((token) => (
        token.endsWith(
            '/run-release-reliability-scenarios.mjs'
        )
    )) && tokens.some((token) => (
        token === '--scenario' || token.startsWith('--scenario=')
    ));
}

function isReleaseReliabilityRawDriverCommand(command)
{
    const tokens = String(command ?? '').trim().split(/\s+/u)
        .map((token) => token.replaceAll(/['"]/gu, ''));
    return tokens.some((token) => (
        token.endsWith('/run-release-reliability-scenarios.mjs')
    ));
}

function isReleaseReliabilityQualifiedAuthorityCommand(command)
{
    const tokens = String(command ?? '').trim().split(/\s+/u)
        .map((token) => token.replaceAll(/['"]/gu, ''));
    return tokens.some((token) => (
        token.endsWith('/run-release-reliability-qualified-local.sh')
    ));
}

export function managedProductionBuildGcTier(runId, { outputRoot = null } = {})
{
    const receipt = outputRoot
        ? relativeToRoot(path.join(outputRoot, 'release-evidence', 'build-gc', `${runId}.json`))
        : `.tmp/release-evidence/build-gc/${runId}.json`;
    return {
        id: 'managed-production-build-gc',
        owner: 'governance',
        command: `node tools/test-matrix/production-build-gc.mjs --root . --current-run ${runId} --byte-budget 17179869184 --inode-budget 500000`,
        executionDependsOn: [],
        services: [],
        parallelizable: false,
        exclusiveResources: ['build-root-gc', 'disk-heavy'],
        phase: 0,
        cost: 'high',
        resourceClass: 'io',
        cpuWeight: 1,
        memoryWeight: 0.5,
        minCpuUnits: 1,
        cpuUnits: 1,
        memoryGiB: 0.1,
        resourceGrantMode: 'static',
        requiresBootstrap: 'none',
        requiresNode: true,
        requiresDotnet: false,
        requiresPlaywright: 'none',
        cacheProfile: 'none',
        timeoutMinutes: 5,
        shardable: false,
        risk: 'high',
        cadence: 'pr',
        requiredFor: 'none',
        coverage: [],
        artifacts: [receipt],
        evidence: [receipt],
        ciJob: 'managed-production-build-gc',
        localOnly: true,
        nightlyOnly: false,
        targetRoots: ['.tmp/build'],
        ioBudget: { byteBudget: 17179869184, inodeBudget: 500000 },
        measurementIsolation: 'preflight-before-build'
    };
}

function prependManagedProductionBuildGc(tiers, runId, { enabled = true, outputRoot = null } = {})
{
    if (!enabled)
    {
        return tiers;
    }
    const gc = managedProductionBuildGcTier(runId, { outputRoot });
    return [gc, ...tiers.map((tier) => ({
        ...tier,
        executionDependsOn: [gc.id, ...tierExecutionDependencies(tier)]
    }))];
}

function prependBehaviorDocCapacityAuthority(tiers)
{
    const admission = {
        id: behaviorDocAdmissionTierId,
        executionDependsOn: [],
        exclusiveResources: ['behavior-doc-contract-build']
    };
    return [admission, ...tiers.map((tier) => ({
        ...tier,
        executionDependsOn: [
            behaviorDocAdmissionTierId,
            ...tierExecutionDependencies(tier)
                .filter((dependency) => dependency !== behaviorDocAdmissionTierId)
        ]
    }))];
}

function readProductionResumeCheckpointAuthority(runIdentity)
{
    const checkpointPath = path.resolve(
        runIdentity.runsRoot,
        runIdentity.runId,
        'checkpoint.json');
    if (!fs.existsSync(checkpointPath))
    {
        return {
            mode: 'physical-resume',
            checkpointPath,
            checkpointExists: false,
            checkpointIdentity: null,
            checkpointDigest: null,
            authorityDigest: contentDigest({
                checkpointPath,
                checkpointExists: false,
                runId: runIdentity.runId
            })
        };
    }
    const metadata = fs.lstatSync(checkpointPath);
    if (metadata.isSymbolicLink() || !metadata.isFile())
    {
        throw new Error(`Production resume checkpoint is not a regular file: ${checkpointPath}`);
    }
    const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
    if (checkpoint.runId !== runIdentity.runId)
    {
        throw new Error(
            `Production resume checkpoint run ${checkpoint.runId} does not match ${runIdentity.runId}`);
    }
    const checkpointIdentity = {
        device: String(metadata.dev),
        inode: String(metadata.ino),
        mode: metadata.mode,
        size: metadata.size
    };
    const checkpointDigest = fileDigest(checkpointPath);
    const authority = {
        mode: isProjectionOnlyCheckpointFailure(checkpoint)
            ? 'projection-only'
            : 'physical-resume',
        checkpointPath,
        checkpointExists: true,
        checkpointIdentity,
        checkpointDigest,
        checkpointRevision: checkpoint.revision,
        checkpointStatus: checkpoint.status,
        checkpointAttemptId: checkpoint.productionFreshOutputAttemptId ?? null,
        runId: runIdentity.runId
    };
    return {
        ...authority,
        authorityDigest: contentDigest(authority)
    };
}

function assertProductionResumeCheckpointAuthorityStable(authority, runIdentity)
{
    const current = readProductionResumeCheckpointAuthority(runIdentity);
    if (current.authorityDigest !== authority.authorityDigest
    || current.mode !== authority.mode
    || current.checkpointDigest !== authority.checkpointDigest)
    {
        const error = new Error(
            `Production resume checkpoint authority drifted after capacity admission: ${authority.checkpointPath}`);
        error.code = 'PRODUCTION_RESUME_CHECKPOINT_DRIFT';
        throw error;
    }
    return current;
}

function canonicalize(value)
{
    if (Array.isArray(value))
    {
        return value.map(canonicalize);
    }
    if (!value || typeof value !== 'object')
    {
        return value;
    }
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function contentDigest(value)
{
    const content = { ...value };
    delete content.contentDigest;
    return `sha256:${createHash('sha256').update(JSON.stringify(canonicalize(content))).digest('hex')}`;
}

function sealContentDigest(value)
{
    const sealed = { ...value, contentDigest: null };
    sealed.contentDigest = contentDigest(sealed);
    return sealed;
}

const requiredFields = [
    'id',
    'owner',
    'command',
    'executionDependsOn',
    'services',
    'parallelizable',
    'exclusiveResources',
    'phase',
    'cost',
    'resourceClass',
    'cpuWeight',
    'memoryWeight',
    'minCpuUnits',
    'requiresBootstrap',
    'requiresNode',
    'requiresDotnet',
    'requiresPlaywright',
    'cacheProfile',
    'timeoutMinutes',
    'shardable',
    'risk',
    'cadence',
    'requiredFor',
    'coverage',
    'artifacts',
    'evidence',
    'ciJob',
    'localOnly',
    'nightlyOnly'
];

function loadMatrix({ validateDependencyFields = true, declarationsOnly = false } = {})
{
    if (!fs.existsSync(matrixFile))
    {
        throw new Error(`missing ${path.relative(root, matrixFile)}`);
    }
    const matrix = parseMatrix(
        fs.readFileSync(matrixFile, 'utf8'),
        { validateDependencyFields }
    );
    const releaseFinalStaticBoundaryErrors = validateReleaseFinalStaticBoundary({
        matrix,
        scriptSource: fs.readFileSync(path.join(root, 'tools/test/lanes/release-final.sh'), 'utf8'),
        repositoryRoot: root,
        declarationsOnly
    });
    if (releaseFinalStaticBoundaryErrors.length > 0)
    {
        throw new Error(
            'release-final static boundary rejected matrix parse:\n'
            + releaseFinalStaticBoundaryErrors.join('\n')
        );
    }
    return matrix;
}

function loadCoverageRegistry()
{
    if (!fs.existsSync(coverageRegistryFile))
    {
        return { errors: ['missing tests/coverage-registry.json'], entries: new Map() };
    }
    try
    {
        const registry = JSON.parse(fs.readFileSync(coverageRegistryFile, 'utf8'));
        if (registry?.schema !== 'fsusblog.coverage-registry.v1')
        {
            return { errors: [`coverage registry schema must be fsusblog.coverage-registry.v1, got ${registry?.schema ?? 'missing'}`], entries: new Map() };
        }
        if (!Array.isArray(registry.entries))
        {
            return { errors: ['coverage registry entries must be an array'], entries: new Map() };
        }
        return {
            errors: [],
            entries: new Map(registry.entries.map((entry) => [entry.id, entry]))
        };
    }
    catch (error)
    {
        return {
            errors: [`coverage registry is not valid JSON: ${error.message}`],
            entries: new Map()
        };
    }
}

function relativeToRoot(filePath)
{
    return path.relative(root, filePath).replaceAll(path.sep, '/');
}

function tierMap(matrix)
{
    return new Map(matrix.tiers.map((tier) => [tier.id, tier]));
}

function tierExecutionDependencies(tier)
{
    return tier?.executionDependsOn ?? tier?.dependsOn ?? [];
}

export function logicalTierSystemResources()
{
    const cpuCount = Math.max(1, os.availableParallelism?.() ?? os.cpus().length);
    const load1 = process.platform === 'win32' ? 0 : Math.max(0, os.loadavg()[0]);
    return {
        cpuCount,
        availableCpuUnits: cpuCount,
        availableMemoryGiB: Math.max(Number.EPSILON, availableMemoryGiB()),
        totalMemoryGiB: Math.max(Number.EPSILON, os.totalmem() / (1024 ** 3)),
        load1
    };
}

export function logicalTierPlanningResources()
{
    return {
        availableCpuUnits: Math.max(1, os.availableParallelism?.() ?? os.cpus().length),
        totalMemoryGiB: Math.max(Number.EPSILON, os.totalmem() / (1024 ** 3))
    };
}

// These are planning annotations, never runnable CPU/memory grants. Execution
// retains the complete real-headroom resolver and its admission checks.
export function projectLogicalTierPlanningMetadata(tiers, resources = logicalTierPlanningResources())
{
    const cpuCount = Number(resources.availableCpuUnits);
    const totalMemoryGiB = Number(resources.totalMemoryGiB);
    if (!Number.isFinite(cpuCount) || cpuCount < 1
        || !Number.isFinite(totalMemoryGiB) || totalMemoryGiB <= 0)
    {
        throw new Error('logical tier planning requires observed CPU capacity and total memory');
    }
    const cpuUnits = Math.max(1, Math.floor(cpuCount));
    return new Map(tiers.map((tier) => [tier.id, {
        maxParallel: tier.parallelizable === true ? cpuUnits : 1,
        defaultShards: tier.shardable === true ? dynamicShardCount(resources) : 1,
        playwrightWorkers: playwrightWorkersForTier(tier, () => cpuUnits)
    }]));
}

function dynamicShardCount(resources)
{
    // A CI matrix and its later aggregate job run in different processes and at
    // different load levels.  Derive topology from stable machine capacity, not
    // momentary free memory, so both sides name the same shard artifacts while
    // admission-time CPU/memory grants can still react to live pressure.
    const memorySupportedCpu = Math.max(1, resources.totalMemoryGiB / 2);
    const machineCapacity = Math.max(1, Math.min(resources.availableCpuUnits, memorySupportedCpu));
    return Math.max(1, Math.min(
        Math.floor(resources.availableCpuUnits),
        Math.ceil(Math.sqrt(machineCapacity))
    ));
}

function resolveLogicalTierResources(tiers, resources = logicalTierSystemResources())
{
    const cpuBudget = Math.max(1, Math.floor(resources.availableCpuUnits));
    const memoryBudget = Math.max(Number.EPSILON, Number(resources.availableMemoryGiB));
    return tiers.map((tier) =>
    {
        const hasExplicitFixtureGrant = Number.isFinite(Number(tier.cpuUnits)) && Number(tier.cpuUnits) > 0
      && Number.isFinite(Number(tier.memoryGiB)) && Number(tier.memoryGiB) > 0;
        return {
            ...tier,
            // Explicit units are accepted only for isolated scheduler fixtures. The
            // repository matrix validator forbids them, so real logical tiers always
            // use admission-time dynamic grants.
            cpuUnits: hasExplicitFixtureGrant ? Number(tier.cpuUnits) : cpuBudget,
            memoryGiB: hasExplicitFixtureGrant ? Number(tier.memoryGiB) : memoryBudget,
            resourceGrantMode: hasExplicitFixtureGrant ? 'fixed' : 'dynamic',
            maxParallel: tier.parallelizable === true ? cpuBudget : 1,
            defaultShards: tier.shardable === true ? dynamicShardCount(resources) : 1,
            budgetMs: Number(tier.timeoutMinutes) * 60_000
        };
    });
}

function applyDirectCorrectnessBudgetPolicy(tiers)
{
    return tiers;
}

function normalizeTierId(id)
{
    return aliases.get(id) ?? id;
}

function playwrightWorkersForTier(tier, cpuUnitsForWorkers = () => tierResourceUnits(tier).cpuUnits)
{
    if (tier.id === 'browser-contract')
    {
        return 1;
    }
    return tier.requiresPlaywright === 'none'
        ? null
        : Math.max(1, Math.floor(cpuUnitsForWorkers()));
}

function pathExistsForCommand(command)
{
    const [first] = String(command).split(/\s+/);
    if (!first || !/^(tools|tests|src|\.\/tools|\.\/tests|\.\/src)\//.test(first))
    {
        return true;
    }
    const rel = first.replace(/^\.\//, '');
    return fs.existsSync(path.join(root, rel));
}

function isExecutableCommand(command)
{
    const [first] = String(command).split(/\s+/);
    if (!first || !/^(tools|tests|src|\.\/tools|\.\/tests|\.\/src)\//.test(first))
    {
        return true;
    }
    const rel = first.replace(/^\.\//, '');
    const filePath = path.join(root, rel);
    try
    {
        const stat = fs.statSync(filePath);
        if ((stat.mode & 0o111) !== 0)
        {
            return true;
        }
        if (process.platform === 'win32')
        {
            if (/\.(?:sh|mjs|js)$/i.test(rel))
            {
                return true;
            }
            const head = fs.readFileSync(filePath, 'utf8').slice(0, 2);
            return head === '#!';
        }
        return false;
    }
    catch
    {
        return false;
    }
}

function isStaticOnlyEvidencePath(value)
{
    const normalized = String(value ?? '').replaceAll(path.sep, '/');
    return normalized.startsWith('docs/')
    || normalized.endsWith('.md')
    || normalized.startsWith('tests/matrix')
    || normalized.startsWith('tests/coverage-registry')
    || normalized.startsWith('tests/backend/Fixtures/')
    || normalized.startsWith('tests/frontend/fixtures/')
    || normalized.startsWith('src/shared/Contracts/Validation/')
    || normalized.startsWith('src/frontend/src/generated/');
}

function unitTestEvidencePath(value)
{
    const normalized = String(value ?? '').replaceAll(path.sep, '/');
    return /^tests\/backend\/Unit\/.+\.cs$/.test(normalized)
    || /^tests\/frontend\/unit\/.+\.(test|spec)\.[cm]?[jt]sx?$/.test(normalized)
    || /^tests\/frontend\/property\/.+\.(test|spec)\.[cm]?[jt]sx?$/.test(normalized);
}

function validateCoverageRegistry(matrix)
{
    const errors = [];
    const { errors: registryErrors, entries } = loadCoverageRegistry();
    errors.push(...registryErrors);
    if (registryErrors.length > 0)
    {
        return errors;
    }

    const coverageToTiers = new Map();
    for (const tier of matrix.tiers ?? [])
    {
        for (const coverageId of tier.coverage ?? [])
        {
            if (!coverageToTiers.has(coverageId))
            {
                coverageToTiers.set(coverageId, []);
            }
            coverageToTiers.get(coverageId).push(tier);
        }
    }

    for (const [coverageId, tiers] of coverageToTiers.entries())
    {
        const entry = entries.get(coverageId);
        if (!entry)
        {
            errors.push(`coverage ${coverageId} missing registry entry`);
            continue;
        }

        if (entry.id !== coverageId)
        {
            errors.push(`coverage ${coverageId} registry id mismatch`);
        }
        const matrixTierIds = new Set(tiers.map((tier) => tier.id));
        if (!Array.isArray(entry.tierIds) || entry.tierIds.length === 0)
        {
            errors.push(`coverage ${coverageId}.tierIds must be non-empty`);
        }
        else
        {
            const registryTierIds = new Set(entry.tierIds);
            const duplicateTierIds = entry.tierIds.filter((tierId, index) => entry.tierIds.indexOf(tierId) !== index);
            if (duplicateTierIds.length > 0)
            {
                errors.push(`coverage ${coverageId}.tierIds contains duplicates: ${[...new Set(duplicateTierIds)].join(', ')}`);
            }
            for (const tierId of registryTierIds)
            {
                if (!(matrix.tiers ?? []).some((tier) => tier.id === tierId))
                {
                    errors.push(`coverage ${coverageId}.tierIds references unknown tier: ${tierId}`);
                }
            }
            if (!sameSet(registryTierIds, matrixTierIds))
            {
                errors.push(`coverage ${coverageId}.tierIds must exactly match matrix covering tiers; registry=${[...registryTierIds].sort().join(',')} matrix=${[...matrixTierIds].sort().join(',')}`);
            }
        }
        if (typeof entry.description !== 'string' || entry.description.length === 0)
        {
            errors.push(`coverage ${coverageId}.description missing`);
        }
        else if (coverageTemplateDescriptionPattern.test(entry.description))
        {
            errors.push(`coverage ${coverageId}.description must describe the covered behavior, not use the generic Coverage contract template`);
        }
        if (typeof entry.owner !== 'string' || entry.owner.length === 0)
        {
            errors.push(`coverage ${coverageId}.owner missing`);
        }
        if (!['low', 'medium', 'high', 'critical'].includes(entry.risk))
        {
            errors.push(`coverage ${coverageId}.risk invalid: ${entry.risk}`);
        }
        if (!coverageAssertionTypes.includes(entry.assertionType))
        {
            errors.push(`coverage ${coverageId}.assertionType invalid: ${entry.assertionType}`);
        }
        if (typeof entry.failClosedRule !== 'string' || entry.failClosedRule.length === 0)
        {
            errors.push(`coverage ${coverageId}.failClosedRule missing`);
        }
        if (typeof entry.minimumRequirement !== 'string' || entry.minimumRequirement.length === 0)
        {
            errors.push(`coverage ${coverageId}.minimumRequirement missing`);
        }
        else if (genericCoverageMinimumRequirementPattern.test(entry.minimumRequirement))
        {
            errors.push(`coverage ${coverageId}.minimumRequirement must state the minimum assertion or evidence, not repeat the tier type`);
        }
        if (!Array.isArray(entry.evidencePaths) || entry.evidencePaths.length === 0)
        {
            errors.push(`coverage ${coverageId}.evidencePaths must be non-empty`);
            continue;
        }

        if (entry.evidencePaths.every(unitTestEvidencePath) && entry.assertionType !== 'unit')
        {
            errors.push(`coverage ${coverageId}.assertionType must be unit because all evidence paths are unit/property test files`);
        }

        const declaredPaths = new Set(tiers.flatMap((tier) => [...(tier.evidence ?? []), ...(tier.artifacts ?? [])]));
        for (const evidencePath of entry.evidencePaths)
        {
            if (typeof evidencePath !== 'string' || evidencePath.length === 0)
            {
                errors.push(`coverage ${coverageId}.evidencePaths contains an invalid path`);
            }
            else if (!declaredPaths.has(evidencePath))
            {
                errors.push(`coverage ${coverageId}.evidencePaths path is not declared by a covering tier: ${evidencePath}`);
            }
        }

        for (const tier of tiers)
        {
            const tierPaths = new Set([...(tier.evidence ?? []), ...(tier.artifacts ?? [])]);
            if (!entry.evidencePaths.some((evidencePath) => tierPaths.has(evidencePath)))
            {
                errors.push(`coverage ${coverageId} has no registry evidence path for tier ${tier.id}`);
            }
        }

        if (runtimeLikeCoverageAssertionTypes.has(entry.assertionType) && entry.evidencePaths.every(isStaticOnlyEvidencePath))
        {
            errors.push(`coverage ${coverageId} assertionType ${entry.assertionType} must not rely only on static docs/source evidence`);
        }
    }

    for (const coverageId of entries.keys())
    {
        if (!coverageToTiers.has(coverageId))
        {
            errors.push(`coverage registry contains unused id: ${coverageId}`);
        }
    }

    return errors;
}

function sameSet(left, right)
{
    if (left.size !== right.size)
    {
        return false;
    }
    for (const item of left)
    {
        if (!right.has(item))
        {
            return false;
        }
    }
    return true;
}

function validateFrontendFastSplit(matrix, byId)
{
    const errors = [];
    for (const tierId of frontendFastSplitIds)
    {
        if (!byId.has(tierId))
        {
            errors.push(`frontend fast split missing tier ${tierId}`);
        }
    }

    if (byId.has('frontend-fast'))
    {
        errors.push('frontend-fast must stay split; use frontend-fast-summary alias instead of a monolithic tier');
    }

    const expectedCiJobs = new Map([
        ['frontend-build', 'frontend-build'],
        ['frontend-unit-shard', 'fast-frontend-unit'],
        ['frontend-property-model-perf', 'fast-frontend-unit'],
        ['frontend-runtime-contracts', 'frontend-runtime-contracts'],
        ['frontend-static-governance', 'frontend-static-governance'],
        ['frontend-fast-summary', 'fast-summary']
    ]);
    for (const [tierId, ciJob] of expectedCiJobs.entries())
    {
        const tier = byId.get(tierId);
        if (tier && tier.ciJob !== ciJob)
        {
            errors.push(`${tierId}.ciJob must be ${ciJob}`);
        }
    }

    const unitShard = byId.get('frontend-unit-shard');
    if (unitShard)
    {
        if (unitShard.shardable !== true)
        {
            errors.push('frontend-unit-shard must be shardable');
        }
        if ('defaultShards' in unitShard)
        {
            errors.push('frontend-unit-shard.defaultShards must be machine-resolved');
        }
    }

    for (const tierId of ['frontend-build', 'frontend-runtime-contracts', 'frontend-static-governance'])
    {
        const tier = byId.get(tierId);
        if (tier?.shardable === true)
        {
            errors.push(`${tierId} must run once and must not be shardable`);
        }
    }

    const summary = byId.get('frontend-fast-summary');
    if (summary)
    {
        const actual = new Set(summary.requiresEvidenceFrom ?? []);
        const expected = new Set(frontendFastExecutableSplitIds);
        if (!sameSet(actual, expected))
        {
            errors.push(`frontend-fast-summary.requiresEvidenceFrom must be ${frontendFastExecutableSplitIds.join(',')}`);
        }
        if (tierExecutionDependencies(summary).length > 0)
        {
            errors.push('frontend-fast-summary.executionDependsOn must be empty');
        }
    }

    const fast = byId.get('fast');
    if (fast)
    {
        if ((fast.requiresEvidenceFrom ?? []).includes('frontend-fast'))
        {
            errors.push('fast must not require evidence from deprecated frontend-fast');
        }
        for (const tierId of frontendFastExecutableSplitIds)
        {
            if (!(fast.requiresEvidenceFrom ?? []).includes(tierId))
            {
                errors.push(`fast must require evidence from ${tierId}`);
            }
        }
        if (tierExecutionDependencies(fast).length > 0)
        {
            errors.push('fast.executionDependsOn must be empty');
        }
    }

    return errors;
}

function commandSourcePath(command)
{
    return String(command ?? '')
        .split(/\s+/u)
        .map((token) => token.replace(/^['"]|['"]$/gu, ''))
        .find((token) => token.startsWith('tools/') && fs.existsSync(path.join(root, token))) ?? null;
}

function cacheInputCoversSource(patternValue, sourcePath)
{
    const pattern = String(patternValue).replace(/^\.\//u, '').replaceAll('\\', '/');
    if (pattern === sourcePath || (!pattern.includes('*') && sourcePath.startsWith(`${pattern.replace(/\/$/u, '')}/`)))
    {
        return true;
    }
    const escaped = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replaceAll('**', '\u0000')
        .replaceAll('*', '[^/]*')
        .replaceAll('\u0000', '.*');
    return new RegExp(`^${escaped}$`, 'u').test(sourcePath);
}

function validateMatrixSchema(matrix)
{
    if (!fs.existsSync(schemaFile))
    {
        return ['missing tests/matrix.schema.json'];
    }
    const result = spawnSync(process.execPath, [schemaValidatorFile, schemaFile], {
        cwd: root,
        encoding: 'utf8',
        input: JSON.stringify(matrix),
        maxBuffer: 16 * 1024 * 1024
    });
    if (result.status !== 0)
    {
        const detail = result.stderr.trim() || `validator exited with ${result.status}`;
        return [`matrix schema validator failed: ${detail}`];
    }
    try
    {
        return JSON.parse(result.stdout).map((error) => `schema ${error}`);
    }
    catch (error)
    {
        return [`matrix schema validator returned invalid output: ${error.message}`];
    }
}

// BEHAVIOR-OWNER: release-final-aggregate-contract
function validateReleaseFinalAggregateAuthorities(matrix)
{
    return Object.keys(matrix.finalizerAuthorities ?? {}).sort().flatMap((authorityId) =>
        buildReleaseFinalizerPlan(matrix, authorityId).errors
            .map((error) => `finalizerAuthorities.${authorityId}: ${error}`));
}

// BEHAVIOR-OWNER: deployment-blue-green-runtime-role
function validateDeploymentDomainAuthorities(matrix)
{
    return validateReleaseDomainMatrix(root, matrix);
}

function validateMatrix(matrix)
{
    const errors = [];
    errors.push(...validateReleaseFinalStaticBoundary({
        matrix,
        scriptSource: fs.readFileSync(path.join(root, 'tools/test/lanes/release-final.sh'), 'utf8'),
        repositoryRoot: root
    })
        .map((error) => `releaseFinalStaticBoundary: ${error}`));
    const ids = new Set();
    const byId = tierMap(matrix);
    errors.push(...validateExecutionEnvelopeContracts({
        matrix,
        policy: loadExecutionEnvelopePolicy(),
        catalog: loadExecutionEnvelopeApplicability()
    }).map((error) => `executionEnvelope: ${error}`));
    errors.push(...validateExecutionServiceCatalog(loadExecutionServiceCatalog(), matrix)
        .map((error) => `executionServiceCatalog: ${error}`));
    errors.push(...validateExecutionNetworkPolicy(loadExecutionNetworkPolicy())
        .map((error) => `executionNetworkPolicy: ${error}`));
    errors.push(...validateCorrectnessBudgetPolicy(loadCorrectnessBudgetPolicy(), matrix)
        .map((error) => `correctnessBudgetPolicy: ${error}`));

    function hasBootstrapDependencyPath(tierId, seen = new Set())
    {
        if (seen.has(tierId))
        {
            return false;
        }
        seen.add(tierId);
        const tier = byId.get(tierId);
        for (const dep of tierExecutionDependencies(tier))
        {
            if (dep === 'bootstrap' || hasBootstrapDependencyPath(dep, seen))
            {
                return true;
            }
        }
        return false;
    }

    if (matrix.version !== 'fsusblog-test-matrix-v2')
    {
        errors.push(`version must be fsusblog-test-matrix-v2, got ${matrix.version ?? 'missing'}`);
    }
    errors.push(...validateMatrixSchema(matrix));
    for (const authorityId of Object.keys(matrix.aggregateAuthorities ?? {}).sort())
    {
        errors.push(...buildAggregateReachabilityPlan(matrix, authorityId).errors
            .map((error) => `aggregateAuthorities.${authorityId}: ${error}`));
    }
    for (const authorityId of Object.keys(matrix.receiptAuthorities ?? {}).sort())
    {
        errors.push(...buildReceiptReachabilityPlan(matrix, authorityId, { root }).errors
            .map((error) => `receiptAuthorities.${authorityId}: ${error}`));
    }
    errors.push(...validateReleaseFinalAggregateAuthorities(matrix));
    if (!Array.isArray(matrix.tiers) || matrix.tiers.length === 0)
    {
        errors.push('tiers must be a non-empty list');
    }

    const expectedCommandGroups = new Map([
        ['frontend-static-governance', 'fsusblog.frontend-static-command-manifest.v2'],
        ['frontend-runtime-contracts', 'fsusblog.test-command-manifest.v1']
    ]);
    const commandGroups = matrix.commandGroups ?? {};
    if (Object.keys(commandGroups).sort().join(',') !== [...expectedCommandGroups.keys()].sort().join(','))
    {
        errors.push('commandGroups must declare exactly frontend-static-governance and frontend-runtime-contracts');
    }
    const commandIds = new Set();
    const flattenCommands = (commands) => (commands ?? []).flatMap((command) => [
        command,
        ...flattenCommands(command.localCommands)
    ]);
    for (const [groupId, expectedSchema] of expectedCommandGroups)
    {
        const group = commandGroups[groupId];
        if (!group)
        {
            continue;
        }
        if (group.schema !== expectedSchema)
        {
            errors.push(`${groupId}.schema must be ${expectedSchema}`);
        }
        if (group.lane !== groupId)
        {
            errors.push(`${groupId}.lane must match its matrix key`);
        }
        const commands = flattenCommands(group.commands);
        if (commands.length === 0)
        {
            errors.push(`${groupId}.commands must not be empty`);
        }
        const localIds = new Set(commands.map((command) => command?.id).filter(Boolean));
        for (const command of commands)
        {
            if (!String(command?.id ?? '').trim())
            {
                errors.push(`${groupId} contains a command without id`);
                continue;
            }
            if (commandIds.has(command.id))
            {
                errors.push(`duplicate command id: ${command.id}`);
            }
            commandIds.add(command.id);
            if (!String(command?.script ?? '').trim() && !Array.isArray(command?.command))
            {
                errors.push(`${groupId}.${command.id} requires script or command`);
            }
            for (const dependencyId of command.dependsOn ?? [])
            {
                if (!localIds.has(dependencyId))
                {
                    errors.push(`${groupId}.${command.id} has unknown dependency ${dependencyId}`);
                }
            }
        }
    }

    const retention = matrix.governance?.retention;
    if (!retention || retention.baseline !== 'tests/test-retention-before.json'
    || retention.replacementLedger !== 'tests/test-retention-replacements.json'
    || retention.automaticDeletion !== false)
    {
        errors.push('governance.retention must bind the tracked baseline and replacement ledger with automaticDeletion=false');
    }
    const retiredFromIds = new Set();
    for (const replacement of matrix.governance?.retiredTiers ?? [])
    {
        if (retiredFromIds.has(replacement?.from))
        {
            errors.push(`duplicate retired tier: ${replacement?.from}`);
        }
        retiredFromIds.add(replacement?.from);
        if (!byId.has(replacement?.to))
        {
            errors.push(`retired tier ${replacement?.from} references missing replacement ${replacement?.to}`);
        }
    }

    for (const tier of matrix.tiers)
    {
        if (!tier.id)
        {
            errors.push('tier missing id');
            continue;
        }
        if (ids.has(tier.id))
        {
            errors.push(`duplicate tier id: ${tier.id}`);
        }
        ids.add(tier.id);

        for (const field of requiredFields)
        {
            if (!(field in tier))
            {
                errors.push(`${tier.id} missing ${field}`);
            }
        }
        errors.push(...validateEvidenceExecutionDeclaration(tier, matrix));
        for (const field of ['executionDependsOn', 'services', 'exclusiveResources', 'coverage', 'artifacts', 'evidence'])
        {
            if (!Array.isArray(tier[field]))
            {
                errors.push(`${tier.id}.${field} must be an array`);
            }
        }
        errors.push(...validateTierTopology(tier));
        for (const field of ['supersedes', 'cacheInputs'])
        {
            if (field in tier && !Array.isArray(tier[field]))
            {
                errors.push(`${tier.id}.${field} must be an array`);
            }
        }
        const commandSource = commandSourcePath(tier.command);
        if ((tier.cacheInputs?.length ?? 0) > 0 && commandSource && !tier.cacheInputs.some((input) => cacheInputCoversSource(input, commandSource)))
        {
            errors.push(`${tier.id}.cacheInputs must cover command source ${commandSource}`);
        }
        for (const field of ['parallelizable', 'shardable', 'localOnly', 'nightlyOnly', 'requiresNode', 'requiresDotnet'])
        {
            if (typeof tier[field] !== 'boolean')
            {
                errors.push(`${tier.id}.${field} must be boolean`);
            }
        }
        if ('manualOnly' in tier && typeof tier.manualOnly !== 'boolean')
        {
            errors.push(`${tier.id}.manualOnly must be boolean`);
        }
        if ('selfBootstraps' in tier && typeof tier.selfBootstraps !== 'boolean')
        {
            errors.push(`${tier.id}.selfBootstraps must be boolean`);
        }
        if ('workflowBootstraps' in tier && typeof tier.workflowBootstraps !== 'boolean')
        {
            errors.push(`${tier.id}.workflowBootstraps must be boolean`);
        }
        if ('prDefault' in tier && typeof tier.prDefault !== 'boolean')
        {
            errors.push(`${tier.id}.prDefault must be boolean`);
        }
        for (const field of ['triggerPaths', 'triggerFiles', 'triggerCoverage'])
        {
            if (field in tier && !Array.isArray(tier[field]))
            {
                errors.push(`${tier.id}.${field} must be an array`);
            }
        }
        if ('triggerReason' in tier && typeof tier.triggerReason !== 'string')
        {
            errors.push(`${tier.id}.triggerReason must be string`);
        }
        if ('smartGateMode' in tier && !smartGateModeValues.includes(tier.smartGateMode))
        {
            errors.push(`${tier.id}.smartGateMode is invalid: ${tier.smartGateMode}`);
        }
        if ('retentionClass' in tier && !retentionClassValues.includes(tier.retentionClass))
        {
            errors.push(`${tier.id}.retentionClass is invalid: ${tier.retentionClass}`);
        }
        if ('evidenceClass' in tier && !evidenceClassValues.includes(tier.evidenceClass))
        {
            errors.push(`${tier.id}.evidenceClass is invalid: ${tier.evidenceClass}`);
        }
        const releaseReliabilityScenarioCommand =
            isReleaseReliabilityScenarioCommand(tier.command);
        if (releaseReliabilityScenarioCommand && tier.evidenceClass !== 'diagnostic')
        {
            errors.push(`${tier.id} single-scenario release reliability command must use evidenceClass=diagnostic`);
        }
        if (releaseReliabilityScenarioCommand && tier.qualificationEligible !== false)
        {
            errors.push(`${tier.id} single-scenario release reliability command must use qualificationEligible=false`);
        }
        if (releaseReliabilityScenarioCommand && tier.requiredFor !== 'none')
        {
            errors.push(`${tier.id} single-scenario release reliability command must use requiredFor=none`);
        }
        if (releaseReliabilityScenarioCommand && tier.manualOnly !== true)
        {
            errors.push(`${tier.id} single-scenario release reliability command must use manualOnly=true`);
        }
        const releaseReliabilityRawDriverCommand =
            isReleaseReliabilityRawDriverCommand(tier.command);
        if (releaseReliabilityRawDriverCommand && !releaseReliabilityScenarioCommand)
        {
            errors.push(
                `${tier.id} raw release reliability scenario driver cannot be a complete authority; `
                    + 'use release-reliability-fresh'
            );
        }
        const releaseReliabilityQualifiedAuthorityCommand =
            isReleaseReliabilityQualifiedAuthorityCommand(tier.command);
        if (releaseReliabilityQualifiedAuthorityCommand
            && (tier.evidenceClass !== 'correctness'
                || tier.qualificationEligible !== true
                || tier.requiredFor !== 'release-final'))
        {
            errors.push(
                `${tier.id} complete release reliability authority must use evidenceClass=correctness, `
                    + 'qualificationEligible=true, and requiredFor=release-final'
            );
        }
        if (tier.ciJob === 'browser-diagnostics' && tier.evidenceClass !== 'diagnostic')
        {
            errors.push(`${tier.id}.ciJob=browser-diagnostics requires explicit evidenceClass=diagnostic`);
        }
        if (tier.smartGateMode === 'conditional')
        {
            if (typeof tier.triggerReason !== 'string' || tier.triggerReason.trim().length === 0)
            {
                errors.push(`${tier.id}.smartGateMode=conditional requires triggerReason`);
            }
            const triggerCount = (tier.triggerPaths?.length ?? 0) + (tier.triggerFiles?.length ?? 0) + (tier.triggerCoverage?.length ?? 0);
            if (triggerCount === 0 && tier.prDefault !== true)
            {
                errors.push(`${tier.id}.smartGateMode=conditional requires triggerPaths, triggerFiles, triggerCoverage, or prDefault=true`);
            }
        }
        if (typeof tier.timeoutMinutes !== 'number' || tier.timeoutMinutes < 1)
        {
            errors.push(`${tier.id}.timeoutMinutes must be a positive number`);
        }
        for (const field of ['cpuWeight', 'memoryWeight'])
        {
            if (typeof tier[field] !== 'number' || tier[field] <= 0)
            {
                errors.push(`${tier.id}.${field} must be positive`);
            }
        }
        if (!Number.isInteger(tier.minCpuUnits) || tier.minCpuUnits < 1)
        {
            errors.push(`${tier.id}.minCpuUnits must be a positive integer`);
        }
        for (const field of ['cpuUnits', 'memoryGiB'])
        {
            if (field in tier)
            {
                errors.push(`${tier.id}.${field} is resolved at runtime and must not be declared`);
            }
        }
        if ('executionKey' in tier && (typeof tier.executionKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(tier.executionKey)))
        {
            errors.push(`${tier.id}.executionKey is invalid: ${tier.executionKey}`);
        }
        if ('executionVariant' in tier && !executionVariantValues.includes(tier.executionVariant))
        {
            errors.push(`${tier.id}.executionVariant is invalid: ${tier.executionVariant}`);
        }
        if ((tier.supersedes?.length ?? 0) > 0 && !tier.executionKey)
        {
            errors.push(`${tier.id}.supersedes requires executionKey`);
        }
        for (const field of ['supersedes', 'cacheInputs'])
        {
            if (Array.isArray(tier[field]) && tier[field].some((value) => typeof value !== 'string' || value.length === 0))
            {
                errors.push(`${tier.id}.${field} entries must be non-empty strings`);
            }
        }
        if (typeof tier.phase === 'number' && tier.phase < 0)
        {
            errors.push(`${tier.id}.phase must be zero or greater`);
        }
        if (!['low', 'medium', 'high', 'critical'].includes(tier.risk))
        {
            errors.push(`${tier.id}.risk is invalid: ${tier.risk}`);
        }
        if (!cadenceValues.includes(tier.cadence))
        {
            errors.push(`${tier.id}.cadence is invalid: ${tier.cadence}`);
        }
        if (!requiredForValues.includes(tier.requiredFor))
        {
            errors.push(`${tier.id}.requiredFor is invalid: ${tier.requiredFor}`);
        }
        if (tier.manualOnly === true && tier.cadence !== 'release-manual')
        {
            errors.push(`${tier.id}.manualOnly requires cadence=release-manual`);
        }
        if (tier.manualOnly !== true && tier.cadence === 'release-manual')
        {
            errors.push(`${tier.id}.cadence=release-manual requires manualOnly=true`);
        }
        if (tier.nightlyOnly === true && tier.cadence !== 'nightly')
        {
            errors.push(`${tier.id}.nightlyOnly requires cadence=nightly`);
        }
        if (tier.nightlyOnly !== true && tier.cadence === 'nightly')
        {
            errors.push(`${tier.id}.cadence=nightly requires nightlyOnly=true`);
        }
        if (tier.localOnly === true && tier.requiredFor !== 'none')
        {
            errors.push(`${tier.id}.localOnly must use requiredFor=none`);
        }
        if (tier.manualOnly === true && tier.requiredFor === 'production')
        {
            errors.push(`${tier.id}.manualOnly must not be requiredFor=production`);
        }
        if ((tier.risk === 'high' || tier.risk === 'critical') && (tier.cadence === 'pr' || tier.cadence === 'push') && tier.localOnly !== true && tier.requiredFor === 'none')
        {
            errors.push(`${tier.id}.risk=${tier.risk} with cadence=${tier.cadence} needs requiredFor other than none`);
        }
        if (!['low', 'medium', 'high', 'very-high'].includes(tier.cost))
        {
            errors.push(`${tier.id}.cost is invalid: ${tier.cost}`);
        }
        if (!['cpu', 'io', 'browser', 'network', 'benchmark', 'database'].includes(tier.resourceClass))
        {
            errors.push(`${tier.id}.resourceClass is invalid: ${tier.resourceClass}`);
        }
        if (!['none', 'frontend', 'backend', 'full'].includes(tier.requiresBootstrap))
        {
            errors.push(`${tier.id}.requiresBootstrap is invalid: ${tier.requiresBootstrap}`);
        }
        if (!['none', 'chromium', 'all'].includes(tier.requiresPlaywright))
        {
            errors.push(`${tier.id}.requiresPlaywright is invalid: ${tier.requiresPlaywright}`);
        }
        if (tier.requiresPlaywright !== 'none')
        {
            const expectedEvidenceClass = releaseBrowserAuthorityTierIds.has(tier.id)
                ? 'browser-contract'
                : 'diagnostic';
            if (tier.evidenceClass !== expectedEvidenceClass)
            {
                errors.push(`${tier.id}.requiresPlaywright=${tier.requiresPlaywright} requires evidenceClass=${expectedEvidenceClass}`);
            }
        }
        if (tier.evidenceClass === 'browser-contract' && !releaseBrowserAuthorityTierIds.has(tier.id))
        {
            errors.push(`${tier.id}.evidenceClass=browser-contract is reserved for release browser authorities`);
        }
        if (tier.requiresPlaywright !== 'none' && tier.resourceClass !== 'browser')
        {
            errors.push(`${tier.id}.requiresPlaywright=${tier.requiresPlaywright} requires resourceClass=browser`);
        }
        if (!['none', 'frontend', 'backend', 'full'].includes(tier.cacheProfile))
        {
            errors.push(`${tier.id}.cacheProfile is invalid: ${tier.cacheProfile}`);
        }
        const cacheNeedsFrontend = tier.cacheProfile === 'frontend' || tier.cacheProfile === 'full';
        const cacheNeedsBackend = tier.cacheProfile === 'backend' || tier.cacheProfile === 'full';
        if (cacheNeedsFrontend && tier.requiresNode !== true)
        {
            errors.push(`${tier.id}.cacheProfile ${tier.cacheProfile} requires requiresNode=true`);
        }
        if (cacheNeedsBackend && tier.requiresDotnet !== true)
        {
            errors.push(`${tier.id}.cacheProfile ${tier.cacheProfile} requires requiresDotnet=true`);
        }
        if (tier.requiresPlaywright !== 'none' && tier.requiresNode !== true)
        {
            errors.push(`${tier.id}.requiresPlaywright requires requiresNode=true`);
        }
        if ('playwrightWorkers' in tier)
        {
            errors.push(`${tier.id}.playwrightWorkers is machine-resolved and must not be declared`);
        }
        if (tier.parallelizable === false && tier.maxParallel !== 1)
        {
            errors.push(`${tier.id} is not parallelizable and must declare maxParallel=1`);
        }
        if (tier.parallelizable === false && tier.requiresPlaywright !== 'none'
      && (typeof tier.serialReason !== 'string' || tier.serialReason.trim().length === 0))
        {
            errors.push(`${tier.id} serial Playwright execution requires serialReason`);
        }
        if (tier.parallelizable === true && 'maxParallel' in tier)
        {
            errors.push(`${tier.id}.maxParallel is machine-resolved and must be omitted when parallelizable=true`);
        }
        for (const dep of tierExecutionDependencies(tier))
        {
            const depTier = byId.get(dep);
            if (!depTier)
            {
                errors.push(`${tier.id} depends on missing tier ${dep}`);
            }
            else if (typeof tier.phase === 'number' && typeof depTier.phase === 'number' && depTier.phase > tier.phase)
            {
                errors.push(`${tier.id} depends on ${dep} with later phase ${depTier.phase} > ${tier.phase}`);
            }
        }
        for (const producerId of tier.requiresEvidenceFrom ?? [])
        {
            if (producerId === tier.id)
            {
                errors.push(`${tier.id}.requiresEvidenceFrom must not reference itself`);
            }
            else if (!byId.has(producerId))
            {
                errors.push(`${tier.id} requires evidence from missing tier ${producerId}`);
            }
        }
        if (
            tier.requiresBootstrap !== 'none'
      && !hasBootstrapDependencyPath(tier.id)
      && tier.selfBootstraps !== true
      && tier.workflowBootstraps !== true
        )
        {
            errors.push(`${tier.id}.requiresBootstrap=${tier.requiresBootstrap} needs dependency path to bootstrap, selfBootstraps=true, or workflowBootstraps=true`);
        }
        if (tier.requiresBootstrap === 'none' && (tier.selfBootstraps === true || tier.workflowBootstraps === true))
        {
            errors.push(`${tier.id} declares bootstrap source metadata but requiresBootstrap=none`);
        }
        if (!pathExistsForCommand(tier.command))
        {
            errors.push(`${tier.id} command path does not exist: ${tier.command}`);
        }
        else if (!isExecutableCommand(tier.command))
        {
            errors.push(`${tier.id} command path is not executable: ${tier.command}`);
        }
        if (tier.shardable === false && tier.defaultShards !== 1)
        {
            errors.push(`${tier.id} is not shardable and must declare defaultShards=1`);
        }
        if (tier.shardable === true && 'defaultShards' in tier)
        {
            errors.push(`${tier.id}.defaultShards is machine-resolved and must be omitted when shardable=true`);
        }
    }

    errors.push(...validateFrontendFastSplit(matrix, byId));
    errors.push(...validateDeploymentDomainAuthorities(matrix));
    errors.push(...validateBehaviorDocStaticAdmissionMatrix(matrix, { repositoryRoot: root }));
    errors.push(...validateLocalProfiles(matrix.localProfiles, matrix.tiers));
    errors.push(...validateCoverageRegistry(matrix));
    errors.push(...validateSupersedesRules(matrix.tiers, loadCoverageRegistry().entries));

    const visiting = new Set();
    const visited = new Set();
    function visit(id, stack = [])
    {
        if (visited.has(id))
        {
            return;
        }
        if (visiting.has(id))
        {
            errors.push(`cycle detected: ${[...stack, id].join(' -> ')}`);
            return;
        }
        visiting.add(id);
        const tier = byId.get(id);
        for (const dep of tierExecutionDependencies(tier))
        {
            visit(dep, [...stack, id]);
        }
        visiting.delete(id);
        visited.add(id);
    }
    for (const id of ids)
    {
        visit(id);
    }

    function dependencyClosure(targetId)
    {
        const closure = new Set();
        function collect(id)
        {
            if (closure.has(id))
            {
                return;
            }
            const tier = byId.get(id);
            if (!tier)
            {
                return;
            }
            closure.add(id);
            for (const dependency of tierExecutionDependencies(tier))
            {
                collect(dependency);
            }
        }
        collect(targetId);
        return closure;
    }

    const productionCorrectness = byId.get('production-correctness');
    if (!productionCorrectness)
    {
        errors.push('browserless topology missing production-correctness tier');
    }
    else
    {
        if (productionCorrectness.requiresPlaywright !== 'none'
      || productionCorrectness.requiredFor !== 'production'
      || productionCorrectness.evidenceClass !== 'correctness')
        {
            errors.push('production-correctness must use requiresPlaywright=none, requiredFor=production, and evidenceClass=correctness');
        }
        const browserDependencies = [...dependencyClosure('production-correctness')]
            .filter((id) => byId.get(id)?.requiresPlaywright !== 'none');
        if (browserDependencies.length > 0)
        {
            errors.push(`production-correctness dependency closure must be browserless: ${browserDependencies.join(', ')}`);
        }
    }

    const productionAlias = byId.get('production');
    if (productionAlias && JSON.stringify(tierExecutionDependencies(productionAlias)) !== JSON.stringify(['production-correctness']))
    {
        errors.push('production compatibility tier must depend only on production-correctness');
    }

    const browserContract = byId.get('browser-contract');
    if (!browserContract)
    {
        errors.push('release topology missing browser-contract tier');
    }
    else if (
        browserContract.resourceClass !== 'browser'
    || browserContract.requiresPlaywright !== 'chromium'
    || browserContract.evidenceClass !== 'browser-contract'
    || browserContract.parallelizable !== false
    || browserContract.timeoutMinutes !== 10
    || browserContract.requiredFor !== 'release-final'
    || browserContract.ciJob !== 'browser-contract'
    || browserContract.selfBootstraps !== true
    || JSON.stringify(tierExecutionDependencies(browserContract)) !== JSON.stringify(['production-build-artifacts'])
    )
    {
        errors.push('browser-contract must be one self-bootstrapped, unsharded 10m Chromium tier consuming only production-build-artifacts');
    }

    const productionXssRelease = byId.get('production-xss-release');
    if (!productionXssRelease
        || productionXssRelease.resourceClass !== 'browser'
        || productionXssRelease.requiresPlaywright !== 'all'
        || productionXssRelease.evidenceClass !== 'browser-contract'
        || productionXssRelease.parallelizable !== false
        || productionXssRelease.requiredFor !== 'release-final')
    {
        errors.push('production-xss-release must remain the unsharded cross-engine release XSS browser authority');
    }

    const releaseFinal = byId.get('release-final');
    if (!releaseFinal)
    {
        errors.push('release topology missing release-final tier');
    }
    else
    {
        if (releaseFinal.requiresPlaywright !== 'none' || releaseFinal.evidenceClass !== 'correctness')
        {
            errors.push('release-final finalizer must use evidenceClass=correctness and must not install or launch Playwright itself');
        }
        if (releaseFinal.requiresBootstrap !== 'none'
      || releaseFinal.requiresNode !== true
      || releaseFinal.requiresDotnet !== false
      || releaseFinal.cacheProfile !== 'none'
      || releaseFinal.services.length !== 0)
        {
            errors.push('release-final must be Node-only with no services, bootstrap, .NET, or build/test cache');
        }
        const releaseReliabilityInputs = releaseFinal.requiresEvidenceFrom.filter((tierId) => (
            tierId === 'release-reliability-fresh'
            || isReleaseReliabilityScenarioCommand(byId.get(tierId)?.command)
            || isReleaseReliabilityRawDriverCommand(byId.get(tierId)?.command)
            || isReleaseReliabilityQualifiedAuthorityCommand(byId.get(tierId)?.command)
        ));
        if (JSON.stringify(releaseReliabilityInputs) !== JSON.stringify(['release-reliability-fresh']))
        {
            errors.push('release-final must consume only release-reliability-fresh as its reliability authority');
        }
        const browserDependencies = [...dependencyClosure('release-final')]
            .filter((id) => byId.get(id)?.requiresPlaywright !== 'none')
            .sort();
        if (browserDependencies.length !== 0)
        {
            errors.push(`release-final execution closure must not contain browser tiers: ${browserDependencies.join(', ')}`);
        }
    }

    const releaseReliabilityFresh = byId.get('release-reliability-fresh');
    const qualifiedReleaseReliabilityAuthorityIds = matrix.tiers
        .filter((tier) => isReleaseReliabilityQualifiedAuthorityCommand(tier.command))
        .map((tier) => tier.id);
    if (JSON.stringify(qualifiedReleaseReliabilityAuthorityIds)
        !== JSON.stringify(['release-reliability-fresh']))
    {
        errors.push(
            'matrix must declare exactly one qualified release reliability wrapper authority: '
                + 'release-reliability-fresh'
        );
    }
    if (!releaseReliabilityFresh
        || String(releaseReliabilityFresh.command ?? '').trim()
            !== 'tools/test/run-release-reliability-qualified-local.sh'
        || releaseReliabilityFresh.evidenceClass !== 'correctness'
        || releaseReliabilityFresh.qualificationEligible !== true
        || releaseReliabilityFresh.requiredFor !== 'release-final')
    {
        errors.push(
            'release-reliability-fresh must use tools/test/run-release-reliability-qualified-local.sh '
                + 'as the release-final correctness/qualification-eligible reliability authority'
        );
    }

    errors.push(...validateReleaseReliabilitySchedulerMatrix(
        matrix,
        loadReleaseReliabilityCatalog({ root })
    ));

    return errors;
}

function planTier(matrix, requestedId)
{
    const byId = tierMap(matrix);
    const targetId = normalizeTierId(requestedId);
    if (!byId.has(targetId))
    {
        throw new Error(`unknown tier: ${requestedId}`);
    }

    const planned = [];
    const visited = new Set();

    function visit(id)
    {
        if (visited.has(id))
        {
            return;
        }
        const tier = byId.get(id);
        if (!tier)
        {
            throw new Error(`missing dependency: ${id}`);
        }
        for (const dep of tierExecutionDependencies(tier))
        {
            visit(dep);
        }
        visited.add(id);
        planned.push(tier);
    }

    visit(targetId);
    return planned;
}

export function printPlan(tiers, matrix = null, planningMetadata = null)
{
    for (const [index, tier] of tiers.entries())
    {
        const dependencies = tierExecutionDependencies(tier);
        const deps = dependencies.length > 0 ? ` executionDeps=${dependencies.join(',')}` : '';
        const evidence = (tier.requiresEvidenceFrom ?? []).length > 0
            ? ` evidenceInputs=${tier.requiresEvidenceFrom.join(',')}`
            : '';
        const metadata = planningMetadata?.get(tier.id);
        const shard = tier.shardable ? ` shards=${metadata?.defaultShards ?? tier.defaultShards}` : '';
        const declaredTimeoutMs = planningMetadata ? Number(tier.timeoutMinutes) * 60_000 : tier.budgetMs;
        const timeout = Number.isFinite(Number(declaredTimeoutMs)) && Number(declaredTimeoutMs) > 0
            ? `${Math.ceil(Number(declaredTimeoutMs) / 60_000)}m`
            : 'observe-only';
        console.log(`${index + 1}. ${tier.id} [job=${tier.ciJob} phase=${tier.phase} resource=${tier.resourceClass} cost=${tier.cost} timeout=${timeout} risk=${tier.risk}${shard}]${deps}${evidence}`);
        console.log(`   ${tier.command}`);
        if (tier.id === 'release-final')
        {
            const finalizerPlan = buildReleaseFinalizerPlan(matrix ?? loadMatrix());
            if (finalizerPlan.errors.length)
            {
                throw new Error(finalizerPlan.errors.join('; '));
            }
            console.log(`   requiredEvidenceDependencies=${JSON.stringify(finalizerPlan.requiredEvidenceDependencies)}`);
            console.log(`   planContentDigest=${finalizerPlan.contentDigest}`);
        }
    }
}

function namespaceFor(tier, shard, schedulerRunId = null)
{
    if (process.env.FSUSBLOG_TEST_NAMESPACE?.trim())
    {
        return namespaceSlug(process.env.FSUSBLOG_TEST_NAMESPACE);
    }
    const githubRunId = process.env.GITHUB_RUN_ID;
    const runId = githubRunId || schedulerRunId || 'local';
    const attempt = process.env.GITHUB_RUN_ATTEMPT || '0';
    const job = process.env.MATRIX_JOB || tier.ciJob || tier.id;
    const shardValue = shard ?? process.env.MATRIX_SHARD ?? '0';
    return namespaceSlug(`${runId}-${githubRunId ? attempt : 'fresh'}-${job}-${shardValue}`);
}

function namespaceSlug(value)
{
    const normalized = String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_.-]+/gu, '-')
        .replace(/^-+|-+$/gu, '');
    return !normalized || normalized === '.' || normalized === '..' ? 'local' : normalized;
}

function namespaceEnvironmentRoot(environment = {})
{
    const configured = String(
        environment.FSUSBLOG_ACCEPTANCE_ENV_ROOT
      ?? process.env.FSUSBLOG_ACCEPTANCE_ENV_ROOT
      ?? (activeProductionFreshOutputRoot
          ? path.join(activeProductionFreshOutputRoot, 'runtime', 'acceptance-env')
          : path.join(root, '.tmp/env'))
    ).trim();
    return path.resolve(configured);
}

function loadNamespaceEnv(namespace, environment = {})
{
    const envFile = path.join(namespaceEnvironmentRoot(environment), `${namespaceSlug(namespace)}.env`);
    if (!fs.existsSync(envFile))
    {
        return {};
    }
    const values = {};
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/))
    {
        if (!line || line.startsWith('#'))
        {
            continue;
        }
        const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (!match)
        {
            continue;
        }
        values[match[1]] = match[2];
    }
    return values;
}

export function prepareNamespaceEnvironmentIfNeeded(tiers, namespace, {
    runId,
    sourceState,
    buildLayout,
    environment = {},
    ambientEnvironment = process.env,
    repositoryRoot = root,
    consumeProductionBuildArtifacts = true,
    spawn = spawnSync
} = {})
{
    const bootstrapTier = tiers.find((tier) => tier.selfBootstraps === true);
    if (!bootstrapTier)
    {
        return;
    }
    const normalizedRunId = String(runId ?? '').trim();
    const normalizedSourceState = {
        commit: String(sourceState?.commit ?? '').trim(),
        worktreeFingerprint: String(sourceState?.worktreeFingerprint ?? '').trim()
    };
    if (!normalizedRunId
    || !normalizedSourceState.commit
    || !normalizedSourceState.worktreeFingerprint
    || !buildLayout)
    {
        throw new Error('namespace pre-bootstrap requires scheduler run source and production build identity');
    }
    if (buildLayout.manifest?.sourceState?.commit !== normalizedSourceState.commit
    || buildLayout.manifest?.sourceState?.worktreeFingerprint !== normalizedSourceState.worktreeFingerprint)
    {
        throw new Error('namespace pre-bootstrap source does not exact-match production build identity');
    }
    const bootstrapEnvironment = applyMatrixFixtureProfileEnvironment(
        bootstrapTier,
        productionBuildEnvironment(buildLayout, {
            ...ambientEnvironment,
            ...environment,
            CURRENT_TIER: bootstrapTier.id,
            MATRIX_JOB: bootstrapTier.ciJob,
            FSUSBLOG_TEST_NAMESPACE: namespace,
            FSUSBLOG_TEST_RUN_ID: normalizedRunId,
            FSUSBLOG_TEST_SOURCE_COMMIT: normalizedSourceState.commit,
            FSUSBLOG_TEST_SOURCE_FINGERPRINT: normalizedSourceState.worktreeFingerprint
        })
    );
    if (!consumeProductionBuildArtifacts)
    {
        delete bootstrapEnvironment.FSUSBLOG_CI_PRODUCTION_ARTIFACT_ROOT;
        delete bootstrapEnvironment.FSUSBLOG_CI_PRODUCTION_RECEIPT_DIGEST;
        delete bootstrapEnvironment.FSUSBLOG_CI_PRODUCTION_DOMAINS;
    }
    const envFile = path.join(
        namespaceEnvironmentRoot(bootstrapEnvironment),
        `${namespaceSlug(namespace)}.env`
    );
    if (fs.existsSync(envFile))
    {
        return;
    }
    const result = spawn(
        'bash',
        [path.join(repositoryRoot, 'tools/bootstrap-acceptance-env.sh'), '--prepare-env-only'],
        {
            cwd: repositoryRoot,
            env: bootstrapEnvironment,
            encoding: 'utf8'
        }
    );
    if (result.stdout)
    {
        process.stderr.write(result.stdout);
    }
    if (result.stderr)
    {
        process.stderr.write(result.stderr);
    }
    if (result.status !== 0)
    {
        throw new Error(`failed to prepare namespace environment for ${namespace}`);
    }
}

function applyNamespaceBuildEnvironment(tier, env)
{
    if (tier.id === 'frontend-build' && !env.VITE_API_BASE_URL && env.FSUSBLOG_DEBUG_BACKEND_URL)
    {
        env.VITE_API_BASE_URL = env.FSUSBLOG_DEBUG_BACKEND_URL;
    }
    return env;
}

export function productionFreshEnvironmentForPhysicalTier(layout, tier, ambientEnvironment = {})
{
    const environment = {
        ...ambientEnvironment,
        ...productionFreshOutputEnvironment(layout, tier.id)
    };
    environment.FSUSBLOG_CI_PRODUCTION_RECEIPT_DIGEST = '';
    environment.FSUSBLOG_CI_PRODUCTION_DOMAINS = '';
    if (tier.physicalBundleId !== 'build-static')
    {
        environment.FSUSBLOG_CI_PRODUCTION_ARTIFACT_ROOT = '';
    }
    return environment;
}

/**
 * Seal matrix fixture profile into the child environment.
 * Correctness callers cannot free-override via FSUSBLOG_FIXTURE_PROFILE.
 */
function applyMatrixFixtureProfileEnvironment(tier, env)
{
    const freeOverride = String(process.env.FSUSBLOG_FIXTURE_PROFILE ?? env.FSUSBLOG_FIXTURE_PROFILE ?? '').trim();
    if (freeOverride)
    {
        throw new Error('correctness fixture profile cannot be overridden by FSUSBLOG_FIXTURE_PROFILE');
    }
    if (!Object.hasOwn(tier, 'fixtureProfile'))
    {
    // Clear any ambient free-profile env so non-consumer tiers cannot smuggle overrides.
        env.FSUSBLOG_FIXTURE_PROFILE = '';
        env.FSUSBLOG_SEALED_FIXTURE_CONSUMER_ID = '';
        env.FSUSBLOG_SEALED_FIXTURE_PREREQUISITES = '[]';
        return env;
    }
    const sealed = sealMatrixFixtureProfile(tier);
    return applySealedFixtureProfileEnvironment(env, sealed);
}

function resourceEnvironmentForTier(tier, baseEnv = {})
{
    const { cpuUnits, memoryGiB } = tierResourceUnits(tier);
    const workerBudget = Math.max(1, Math.floor(cpuUnits));
    const cappedWorkerBudget = (name) =>
    {
        const requested = Number.parseInt(String(baseEnv[name] ?? process.env[name] ?? ''), 10);
        return Number.isFinite(requested) && requested > 0 ? Math.min(workerBudget, requested) : workerBudget;
    };
    const env = {
        ...topologyEnvironmentForTier(tier),
        FSUSBLOG_TIER_CPU_UNITS: String(cpuUnits),
        FSUSBLOG_TIER_MEMORY_GIB: String(memoryGiB),
        FSUSBLOG_VITEST_MAX_WORKERS: String(cappedWorkerBudget('FSUSBLOG_VITEST_MAX_WORKERS')),
        FSUSBLOG_COMMAND_MANIFEST_WORKERS: String(cappedWorkerBudget('FSUSBLOG_COMMAND_MANIFEST_WORKERS')),
        FSUSBLOG_PLAYWRIGHT_WORKERS: String(cappedWorkerBudget('FSUSBLOG_PLAYWRIGHT_WORKERS'))
    };
    if (tier.physicalBundleId)
    {
        env.FSUSBLOG_BUNDLE_CPU_BUDGET = String(workerBudget);
        env.FSUSBLOG_BUNDLE_MEMORY_GIB = String(memoryGiB);
        if (Number.isFinite(Number(tier.budgetMs)) && Number(tier.budgetMs) > 0)
        {
            env.FSUSBLOG_BUNDLE_DEADLINE_MS = String(tier.budgetMs);
        }
    }
    if (Number.isFinite(Number(tier.budgetMs)) && Number(tier.budgetMs) > 0)
    {
        env.FSUSBLOG_TIER_DEADLINE_MS = String(tier.budgetMs);
    }
    if (tier.correctnessBudget)
    {
        const budget = tier.correctnessBudget;
        env.FSUSBLOG_CORRECTNESS_BUDGET_POLICY_DIGEST = correctnessBudgetPolicyDigest(loadCorrectnessBudgetPolicy());
        env.FSUSBLOG_CORRECTNESS_BUDGET_TIER_ID = budget.tierId;
        env.FSUSBLOG_PRODUCER_EXECUTION_BUDGET_MS = String(budget.producerExecutionBudgetMs);
        env.FSUSBLOG_TIER_SCHEDULER_BUDGET_MS = String(budget.tierSchedulerBudgetMs);
        env.FSUSBLOG_TERMINATION_GRACE_MS = String(budget.terminationGraceMs);
        env.FSUSBLOG_PROFILE_GLOBAL_BUDGET_MS = String(budget.profileGlobalBudgetMs);
        env.FSUSBLOG_MEASUREMENT_WINDOW_MS =
      budget.measurementWindowMs === 'not-applicable' ? 'not-applicable' : String(budget.measurementWindowMs);
    }
    return env;
}

function mysqlServiceSchedulerOptions(buildLayout, tiers)
{
    if (!tiers.some((tier) => tier.services?.includes('mysql')))
    {
        return {};
    }
    const policy = loadPhysicalExecutionProcessPolicy();
    return {
        resourceEnforcementMode: 'strict',
        resourceEnforcementOptions: { systemdBoundary: {
            commandBudgetMs: policy.systemdControlCommandTimeoutMs,
            startupBudgetMs: policy.systemdResourceStartupTimeoutMs,
            retainBinding: (reference) => retainProductionBuildResourceBoundary(buildLayout, reference, {
                commandBudgetMs: policy.systemdControlCommandTimeoutMs
            })
        } },
        retainManagedContainment: (authority) => retainProductionBuildServiceContainment(buildLayout, authority),
        markManagedContainmentCreationAttempt: (authority, _tier, sender) =>
            markProductionBuildServiceCreationAttempt(buildLayout, authority, sender)
    };
}

export function cleanupSensitiveFixtures(namespace, namespaceEnv = {})
{
    const configuredRoot = namespaceEnv.FSUSBLOG_FIXTURE_ROOT ?? process.env.FSUSBLOG_FIXTURE_ROOT;
    const releaseEvidenceRoot = String(
        namespaceEnv.FSUSBLOG_RELEASE_EVIDENCE_DIR
      ?? process.env.FSUSBLOG_RELEASE_EVIDENCE_DIR
      ?? (activeProductionFreshOutputRoot
          ? path.join(activeProductionFreshOutputRoot, 'release-evidence')
          : path.join(root, '.tmp/release-evidence'))
    ).trim();
    const evidenceFile = path.join(path.resolve(releaseEvidenceRoot), 'sensitive-fixture-cleanup.json');
    ensureOutputDirectory(evidenceFile);
    if (configuredRoot)
    {
        fs.writeFileSync(evidenceFile, `${JSON.stringify({
            schema: 'fsusblog.sensitive-fixture-cleanup.v1',
            status: 'external-root-skipped',
            namespace,
            reason: 'FSUSBLOG_FIXTURE_ROOT is externally managed',
            generatedAt: new Date().toISOString()
        }, null, 2)}\n`);
        return;
    }

    const fixtureBase = String(
        namespaceEnv.FSUSBLOG_ACCEPTANCE_FIXTURE_ROOT
      ?? process.env.FSUSBLOG_ACCEPTANCE_FIXTURE_ROOT
      ?? (activeProductionFreshOutputRoot
          ? path.join(activeProductionFreshOutputRoot, 'runtime', 'acceptance-fixtures')
          : path.join(root, '.tmp/fixtures'))
    ).trim();
    const fixtureRoot = path.join(path.resolve(fixtureBase), namespaceSlug(namespace));
    const authDirectory = path.join(fixtureRoot, 'auth');
    const existed = fs.existsSync(authDirectory);
    fs.rmSync(authDirectory, { recursive: true, force: true });
    fs.writeFileSync(evidenceFile, `${JSON.stringify({
        schema: 'fsusblog.sensitive-fixture-cleanup.v1',
        status: 'ok',
        namespace,
        removedAuthDirectory: existed,
        generatedAt: new Date().toISOString()
    }, null, 2)}\n`);
}

function parseRunOptions(args)
{
    const options = { planOnly: false, shard: null, noDeps: false, resume: false, fresh: false, maxParallel: null, logicalDag: false };
    for (let index = 0; index < args.length; index += 1)
    {
        const arg = args[index];
        if (arg === '--plan-only')
        {
            options.planOnly = true;
        }
        else if (arg === '--no-deps')
        {
            options.noDeps = true;
        }
        else if (arg === '--shard')
        {
            options.shard = args[++index];
        }
        else if (arg.startsWith('--shard='))
        {
            options.shard = arg.slice('--shard='.length);
        }
        else if (arg === '--resume')
        {
            options.resume = true;
        }
        else if (arg === '--fresh')
        {
            options.fresh = true;
        }
        else if (arg === '--logical-dag')
        {
            options.logicalDag = true;
        }
        else if (arg === '--max-parallel')
        {
            options.maxParallel = Number(args[++index]);
        }
        else if (arg.startsWith('--max-parallel='))
        {
            options.maxParallel = Number(arg.slice('--max-parallel='.length));
        }
        else
        {
            throw new Error(`unknown run option: ${arg}`);
        }
    }
    normalizeSchedulerOptions(options);
    return options;
}

function normalizeSchedulerOptions(options)
{
    if (options.resume && options.fresh)
    {
        throw new Error('--resume and --fresh are mutually exclusive');
    }
    if (options.maxParallel !== null && (!Number.isInteger(options.maxParallel) || options.maxParallel < 1))
    {
        throw new Error('--max-parallel must be a positive integer');
    }
    if (process.env.CI === 'true' || process.env.CI === '1' || process.env.GITHUB_ACTIONS === 'true')
    {
        if (options.resume)
        {
            console.error('[matrix] CI forces --fresh; ignoring --resume');
        }
        options.resume = false;
        options.fresh = true;
    }
    else if (!options.resume && !options.fresh)
    {
        options.fresh = true;
    }
}

function schedulerRunIdentity(targetTierId, options)
{
    const runsRoot = path.join(root, '.tmp/test-runs');
    const explicitRunId = process.env.FSUSBLOG_TEST_RUN_ID;
    const resumedRunId = options.resume && !explicitRunId ? findLatestRunId(runsRoot, targetTierId) : null;
    return {
        runsRoot,
        runId: explicitRunId || resumedRunId || createRunId(targetTierId)
    };
}

function resetResumeRunCoordination(runsRoot, runId)
{
    const runDirectory = path.join(runsRoot, runId);
    if (!fs.existsSync(runDirectory))
    {
        return [];
    }
    const removed = [];
    for (const entry of fs.readdirSync(runDirectory, { withFileTypes: true }))
    {
        if (!entry.isFile() && !entry.isSymbolicLink())
        {
            continue;
        }
        if (entry.name === 'checkpoint.json')
        {
            continue;
        }
        fs.rmSync(path.join(runDirectory, entry.name), { force: true });
        removed.push(entry.name);
    }
    return removed.sort();
}

function bindScheduledBuildLayoutSource(layout, sourceState)
{
    return bindProductionBuildLayoutSource(layout, {
        ...sourceState,
        // Lightweight scheduler fixtures may intentionally run outside Git. The
        // authoritative repository preflight rejects that mode before Production.
        commit: sourceState?.commit ?? 'unversioned'
    });
}

function applyUxViewportResumeEnvironment(env, tier)
{
    if (!uxViewportTierIds.has(tier.id))
    {
        return env;
    }
    env.FSUSBLOG_UX_VIEWPORT_RESUME = '0';
    return env;
}

function tierReproductionCommand(tier, options = {})
{
    const args = [`./tools/test.sh ci-tier ${tier.id}`];
    if (options.noDeps)
    {
        args.push('--no-deps');
    }
    if (options.shard)
    {
        args.push(`--shard ${options.shard}`);
    }
    return args.join(' ');
}

function ciJobReproductionCommand(jobId, matrix = null)
{
    if (matrix && ciJobExecutionMode(matrix, jobId) === 'aggregate')
    {
        return `node tools/run-test-matrix.mjs aggregate ${jobId}`;
    }
    return `./tools/test.sh ci-job ${jobId}`;
}

function jobSummaryPath(jobId)
{
    return path.join(
    activeProductionFreshOutputRoot
        ? path.join(activeProductionFreshOutputRoot, 'release-evidence')
        : path.join(root, '.tmp/release-evidence'),
    'jobs',
    `${jobId}.json`);
}

function verifyProductionFreshPhysicalOutputs(runOutputs, { runStatus = 'success' } = {})
{
    const receiptRoot = path.join(runOutputs.outputRoot, 'artifacts', 'producer-receipts');
    const receipts = [];
    if (fs.existsSync(receiptRoot))
    {
        for (const bundleId of fs.readdirSync(receiptRoot).sort())
        {
            const bundleRoot = path.join(receiptRoot, bundleId);
            if (!fs.lstatSync(bundleRoot).isDirectory() || fs.lstatSync(bundleRoot).isSymbolicLink())
            {
                throw new Error(`producer receipt bundle root is invalid: ${relativeToRoot(bundleRoot)}`);
            }
            for (const name of fs.readdirSync(bundleRoot).filter((entry) => entry.endsWith('.json')).sort())
            {
                receipts.push(JSON.parse(fs.readFileSync(path.join(bundleRoot, name), 'utf8')));
            }
        }
    }
    return verifyProductionFreshReceiptInventory({
        layout: runOutputs,
        receipts,
        governanceOutputs: productionFreshGovernanceOutputs(runOutputs),
        requiredReceiptStatus: runStatus === 'success' ? 'complete' : null
    });
}

export function writeSchedulerProducerReceipts(
    runOutputs,
    before,
    { runStatus = 'success', checkpoint = null } = {}
)
{
    const inventory = captureProductionFreshOutputInventory(runOutputs);
    const relativeOutputs = Object.keys(inventory);
    const declarations = {
        'managed-production-build-gc': relativeOutputs.filter((relative) => /^release-evidence\/build-gc\/[^/]+\.json$/u.test(relative)),
        'logical-tier-projection': relativeOutputs.filter((relative) => (
            /^summary\/summary-only\/[^/]+\.json$/u.test(relative)
      || /^release-evidence\/jobs\/[^/]+\.json$/u.test(relative)
      || relative === 'release-evidence/production-artifact-digest-table.json'
        )),
        'production-resource-utilization': relativeOutputs.filter((relative) => relative === 'release-evidence/production-resource-utilization.json'),
        'production-build-layout': relativeOutputs.filter((relative) => relative === 'release-evidence/production-build-layout.json'),
        'forbidden-output-observation': relativeOutputs.filter((relative) => relative === 'runtime/forbidden-output-observation.json'),
        'runtime-cleanup': relativeOutputs.filter(isProductionFreshRuntimeCleanupOutput),
        'sensitive-fixture-cleanup': relativeOutputs.filter(
            (relative) => relative === 'release-evidence/sensitive-fixture-cleanup.json'),
        'run-summary': relativeOutputs.filter((relative) => relative === 'summary/run.json')
    };
    const expected = resolveProductionFreshSchedulerProducerIds(declarations, {
        status: runStatus,
        producerLifecycles: checkpoint?.tiers ?? {}
    });
    const allDeclared = expected.flatMap((producerId) => declarations[producerId]);
    const receipts = expected.map((producerId) => verifyProducerOutputDelta({
        layout: runOutputs,
        producerId: `scheduler/${producerId}`,
        before,
        relativeOutputs: declarations[producerId],
        allowedConcurrentOutputs: relativeOutputs.filter((relative) => !declarations[producerId].includes(relative))
    }));
    const receiptRoot = path.join(runOutputs.outputRoot, 'artifacts', 'producer-receipts', 'scheduler');
    fs.mkdirSync(receiptRoot, { recursive: true });
    for (const receipt of receipts)
    {
        const producerId = receipt.producerId.slice('scheduler/'.length);
        fs.writeFileSync(
            path.join(receiptRoot, `${producerId}.json`),
            `${JSON.stringify({
                ...receipt,
                schema: 'fsusblog.production-fresh.producer-receipt.v1',
                status: 'complete'
            }, null, 2)}\n`,
            { flag: 'wx' });
    }
    return allDeclared;
}

function writeProjectionResumeProducerReceipt(runOutputs, before)
{
    const relativeOutputs = Object.keys(captureProductionFreshOutputInventory(runOutputs)).sort();
    if (relativeOutputs.length === 0)
    {
        throw new Error('projection resume produced no run-bound outputs');
    }
    const receipt = verifyProducerOutputDelta({
        layout: runOutputs,
        producerId: 'scheduler/projection-resume',
        before,
        relativeOutputs
    });
    const receiptRoot = path.join(runOutputs.outputRoot, 'artifacts', 'producer-receipts', 'scheduler');
    fs.mkdirSync(receiptRoot, { recursive: true });
    fs.writeFileSync(
        path.join(receiptRoot, 'projection-resume.json'),
        `${JSON.stringify({
            ...receipt,
            schema: 'fsusblog.production-fresh.producer-receipt.v1',
            status: 'complete'
        }, null, 2)}\n`,
        { flag: 'wx' });
}

function readExistingJobSummary(jobId)
{
    const file = jobSummaryPath(jobId);
    if (!fs.existsSync(file))
    {
        return null;
    }
    try
    {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    catch
    {
        return null;
    }
}

function stageForTier(tier, details = {})
{
    if (details.stage)
    {
        return details.stage;
    }
    if (tier.id === 'validate-matrix')
    {
        return 'setup';
    }
    if (tier.id === 'bootstrap' || String(tier.command).includes('bootstrap-acceptance-env'))
    {
        return 'bootstrap';
    }
    if (tier.id === 'release-evidence' || tier.id === 'release-closeout' || tier.id === 'release-final')
    {
        return 'artifact';
    }
    if (tier.id === 'production')
    {
        return 'summary';
    }
    return 'test';
}

function matrixShardId(value)
{
    const match = String(value ?? '').match(/^(\d+)\/(\d+)$/);
    return match ? `${match[1]}-of-${match[2]}` : null;
}

function shardId(index, total)
{
    return `${index}-of-${total}`;
}

function safeMatrixValue(value)
{
    return String(value ?? '')
        .trim()
        .replace(/[^A-Za-z0-9_.-]/g, '-')
        .replace(/^-+|-+$/g, '');
}

function summaryJobIdForTier(tier, details = {})
{
    if (details.jobId)
    {
        return details.jobId;
    }

    const explicitJobId = safeMatrixValue(process.env.FSUSBLOG_CI_JOB_ID);
    if (explicitJobId)
    {
        return explicitJobId;
    }

    const parts = [tier.ciJob];
    const browser = tier.requiresPlaywright === 'all' ? safeMatrixValue(process.env.FSUSBLOG_PLAYWRIGHT_BROWSERS) : '';
    const shard = matrixShardId(process.env.MATRIX_SHARD);
    if (browser && !browser.includes('-') && !browser.includes(','))
    {
        parts.push(browser);
    }
    if (shard)
    {
        parts.push(shard);
    }
    return parts.filter(Boolean).join('-');
}

function mergeStageDurations(existing, stage, durationMs)
{
    const durations = Object.fromEntries(summaryStages.map((name) => [name, Number(existing?.stageDurationsMs?.[name] ?? 0)]));
    if (summaryStages.includes(stage))
    {
        durations[stage] += Math.max(0, durationMs);
    }
    return durations;
}

function frontendFastTimingFiles(tierId)
{
    const slug = safeMatrixValue(tierId) || 'frontend-fast';
    return {
        summaryFile: path.join(root, '.tmp/frontend/timings', `${slug}.json`),
        jsonlFile: path.join(root, '.tmp/frontend/timings', `${slug}.jsonl`)
    };
}

function readFrontendFastGroupEvidence(tierId)
{
    const { summaryFile, jsonlFile } = frontendFastTimingFiles(tierId);
    if (fs.existsSync(summaryFile))
    {
        const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
        return summary.groups ?? [];
    }
    if (fs.existsSync(jsonlFile))
    {
        return fs.readFileSync(jsonlFile, 'utf8')
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line) => JSON.parse(line));
    }
    return [];
}

function frontendFastGroupEvidence(tier)
{
    if (tier.id !== 'frontend-fast' && tier.id !== 'frontend-fast-summary' && !frontendFastExecutableSplitIds.includes(tier.id))
    {
        return null;
    }
    try
    {
        const tierIds = frontendFastExecutableSplitIds.includes(tier.id)
            ? [tier.id]
            : frontendFastExecutableSplitIds;
        const groups = tierIds.flatMap((tierId) => readFrontendFastGroupEvidence(tierId).map((group) => ({ ...group, tierId })));
        return {
            groupDurationsMs: Object.fromEntries(groups.map((item) => [`${item.tierId}:${item.group}`, Number(item.durationMs) || 0])),
            groupResults: groups
        };
    }
    catch (error)
    {
        return {
            groupDurationsMs: {},
            groupResults: [],
            groupDurationError: error.message
        };
    }
}

function jobEvidenceClassification(tier)
{
    const evidenceClass = tier.evidenceClass
    ?? (tier.ciJob === 'browser-diagnostics' ? 'diagnostic' : 'correctness');
    return {
        evidenceClass,
        affectsCorrectness: evidenceClass === 'correctness'
    };
}

function writeJobSummary(matrix, tier, status, startedAt, details = {})
{
    const jobId = summaryJobIdForTier(tier, details);
    const schedulerRunId = ciSummaryAuthorityId ?? details.schedulerRunId ?? summaryInvocationId;
    const existingCandidate = readExistingJobSummary(jobId);
    const existing = existingCandidate?.schedulerRunId === schedulerRunId ? existingCandidate : null;
    const jobTiers = matrix.tiers
        .filter((item) => item.ciJob === tier.ciJob && item.localOnly !== true && item.nightlyOnly !== true && item.manualOnly !== true)
        .map((item) => item.id);
    const knownTierIds = new Set(matrix.tiers.map((item) => item.id));
    const existingTierIds = (existing?.tierIds ?? []).filter((id) => knownTierIds.has(id));
    const tierIds = [...new Set([...existingTierIds, ...jobTiers.filter((id) => id === tier.id), tier.id])].filter(Boolean);
    const artifacts = [...new Set([
        ...(existing?.artifacts ?? []),
        ...(tier.artifacts ?? []),
        ...(tier.evidence ?? []).filter((item) => String(item).startsWith('.tmp/'))
    ])].sort();
    const playwrightWorkers = playwrightWorkersForTier(tier);
    const deltaMs = Math.max(0, Date.now() - startedAt);
    const durationMs = Math.max(0, Number(existing?.durationMs ?? 0)) + deltaMs;
    const stage = stageForTier(tier, details);
    const groupEvidence = frontendFastGroupEvidence(tier);
    const evidencePlanFile = path.resolve(process.env.FSUSBLOG_RELEASE_EVIDENCE_DIR
        ?? path.join(root, '.tmp/release-evidence'), 'test-plan.json');
    let requiredEvidenceResult = existing?.requiredEvidenceResult ?? null;
    if (fs.existsSync(evidencePlanFile))
    {
        const testPlan = JSON.parse(fs.readFileSync(evidencePlanFile, 'utf8'));
        if (testPlan.requiredEvidenceDependencies?.dependencies
            .some((entry) => entry.producerTierIds.includes(tier.id)))
        {
            requiredEvidenceResult = recordRequiredEvidenceExecution(testPlan, tier.id, status,
                requiredEvidenceResult);
        }
    }
    const summary = sealContentDigest({
        schema: 'fsusblog.ci.job-result.v1',
        jobId,
        ciJob: tier.ciJob,
        tierIds,
        status,
        ...jobEvidenceClassification(tier),
        failureStage: status === 'success' ? null : (details.failureStage ?? stage),
        rootCause: status === 'success' ? null : (details.rootCause ?? `${tier.id} exited non-zero`),
        durationMs,
        stageDurationsMs: mergeStageDurations(existing, stage, deltaMs),
        playwrightWorkers,
        artifacts,
        localReproduction: details.localReproduction ?? ciJobReproductionCommand(tier.ciJob, matrix),
        commit: git(['rev-parse', 'HEAD']) ?? 'unknown',
        runId: process.env.GITHUB_RUN_ID ?? 'local',
        attempt: process.env.GITHUB_RUN_ATTEMPT ?? '0',
        schedulerRunId,
        budgetPolicyDigest: details.budgetPolicyDigest ?? existing?.budgetPolicyDigest ?? null,
        timeoutPhase: details.timeoutPhase ?? existing?.timeoutPhase ?? null,
        physicalBundleId: details.physicalBundleId ?? existing?.physicalBundleId ?? null,
        executionSource: details.executionSource ?? existing?.executionSource ?? 'fresh',
        testIds: [...new Set([...(existing?.testIds ?? []), ...(details.testIds ?? [])])].sort(),
        artifactDigests: {
            ...(existing?.artifactDigests ?? {}),
            ...(details.artifactDigests ?? {})
        },
        requiredEvidenceResult,
        generatedAt: new Date().toISOString(),
        ...(groupEvidence ?? {})
    });
    const outFile = jobSummaryPath(jobId);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, `${JSON.stringify(summary, null, 2)}\n`);
}

function isCiEnvironment()
{
    return process.env.CI === 'true' || process.env.CI === '1' || process.env.GITHUB_ACTIONS === 'true';
}

function githubBehaviorDocAdmissionRunId()
{
    const runId = String(process.env.GITHUB_RUN_ID ?? '').trim();
    const runAttempt = String(process.env.GITHUB_RUN_ATTEMPT ?? '').trim();
    return runId && runAttempt ? `behavior-doc-admission-${runId}-${runAttempt}` : null;
}

function expectedBehaviorDocAdmissionRunId(fallbackRunId)
{
    return String(
        process.env.FSUSBLOG_BEHAVIOR_DOC_ADMISSION_RUN_ID
      ?? githubBehaviorDocAdmissionRunId()
      ?? fallbackRunId
    );
}

function behaviorDocAdmissionReceiptFile(repositoryRoot = root)
{
    return path.resolve(
        repositoryRoot,
        process.env.FSUSBLOG_BEHAVIOR_DOC_ADMISSION_RECEIPT
      ?? defaultBehaviorDocAdmissionReceipt
    );
}

function verifyBehaviorDocAdmissionState(state, repositoryRoot = root)
{
    if (!state?.receiptFile || !state.runId || !state.contentDigest)
    {
        throw new Error('BehaviorDoc static admission state is incomplete');
    }
    const sourceIdentity = sealSourceIdentity(repositoryRoot);
    const receipt = readBehaviorDocStaticAdmissionReceipt(state.receiptFile, {
        expectedRunId: state.runId,
        expectedSourceIdentity: sourceIdentity,
        expectedWorktree: repositoryRoot
    });
    if (receipt.contentDigest !== state.contentDigest)
    {
        throw new Error('BehaviorDoc static admission receipt digest drifted');
    }
    return receipt;
}

export async function establishBehaviorDocAdmission({
    repositoryRoot = root,
    runId,
    outputFile = null,
    requireExisting = process.env.GITHUB_ACTIONS === 'true'
    || Boolean(process.env.FSUSBLOG_BEHAVIOR_DOC_ADMISSION_RECEIPT)
})
{
    const expectedRunId = expectedBehaviorDocAdmissionRunId(runId);
    const receiptFile = outputFile ?? behaviorDocAdmissionReceiptFile(repositoryRoot);
    let receipt;
    if (requireExisting)
    {
        receipt = readBehaviorDocStaticAdmissionReceipt(receiptFile, {
            expectedRunId,
            expectedSourceIdentity: sealSourceIdentity(repositoryRoot),
            expectedWorktree: repositoryRoot
        });
        const expectedDigest = String(
            process.env.FSUSBLOG_BEHAVIOR_DOC_ADMISSION_DIGEST ?? ''
        ).trim();
        if (!expectedDigest || receipt.contentDigest !== expectedDigest)
        {
            throw new Error('existing BehaviorDoc admission receipt digest mismatch');
        }
    }
    else
    {
        const result = await runProtectedBehaviorDocAdmission({
            repositoryRoot,
            runId: expectedRunId,
            outputFile: receiptFile,
            candidateSpawnCountBeforeReceipt: 0
        });
        receipt = result.receipt;
    }
    const state = {
        receiptFile,
        runId: expectedRunId,
        contentDigest: receipt.contentDigest
    };
    verifyBehaviorDocAdmissionState(state, repositoryRoot);
    return state;
}

function bindBehaviorDocAdmissionVerification(tiers, state)
{
    const verifyCommand = [
        'node tools/docs/behavior-doc-static-admission.mjs',
        '--verify', JSON.stringify(state.receiptFile),
        '--run-id', JSON.stringify(state.runId)
    ].join(' ');
    return tiers.map((tier) => tier.id === behaviorDocAdmissionTierId
        ? { ...tier, command: verifyCommand }
        : tier);
}

function appendCurrentRunBehaviorDocAdmissionBinding({
    bindings,
    tiers,
    admission,
    schedulerRunId,
    sourceState
})
{
    if (!tiers.some((tier) => tier.id === behaviorDocAdmissionTierId))
    {
        return;
    }
    bindings.push(createCurrentRunBehaviorDocAdmissionBinding({
        root,
        tierId: behaviorDocAdmissionTierId,
        schedulerRunId,
        admissionRunId: admission.runId,
        sourceState,
        receiptFile: admission.receiptFile
    }));
}

export function executeStaticMatrixPrerequisite(tier, { runId, sourceState, behaviorDocAdmission })
{
    verifyBehaviorDocAdmissionState(behaviorDocAdmission);
    const normalizedRunId = String(runId ?? '').trim();
    const normalizedSourceState = {
        commit: String(sourceState?.commit ?? '').trim(),
        worktreeFingerprint: String(sourceState?.worktreeFingerprint ?? '').trim()
    };
    if (!normalizedRunId
    || !normalizedSourceState.commit
    || !normalizedSourceState.worktreeFingerprint)
    {
        throw new Error(`${tier.id} prerequisite requires scheduler run and source identity`);
    }
    const result = spawnSync(tier.command, {
        cwd: root,
        env: {
            ...process.env,
            FSUSBLOG_TEST_RUN_ID: normalizedRunId,
            FSUSBLOG_TEST_SOURCE_COMMIT: normalizedSourceState.commit,
            FSUSBLOG_TEST_SOURCE_FINGERPRINT: normalizedSourceState.worktreeFingerprint,
            FSUSBLOG_BEHAVIOR_DOC_ADMISSION_RECEIPT: behaviorDocAdmission.receiptFile,
            FSUSBLOG_BEHAVIOR_DOC_ADMISSION_DIGEST: behaviorDocAdmission.contentDigest,
            FSUSBLOG_BEHAVIOR_DOC_ADMISSION_RUN_ID: behaviorDocAdmission.runId
        },
        shell: true,
        stdio: 'inherit'
    });
    if (result.error)
    {
        throw new Error(`${tier.id} prerequisite failed to start: ${result.error.message}`);
    }
    if (result.status !== 0)
    {
        throw new Error(`${tier.id} prerequisite failed with exit ${result.status}`);
    }
    const consumerEvidenceDeclarations = [...new Set([
        ...(tier.artifacts ?? []),
        ...(tier.evidence ?? [])
    ])].filter((declaration) =>
        String(declaration).endsWith(`/${tier.id}-matrix-governance.json`));
    if (consumerEvidenceDeclarations.length !== 1)
    {
        throw new Error(`${tier.id} prerequisite must declare one matrix-governance consumer evidence file`);
    }
    const consumerEvidenceFile = consumerEvidenceDeclarations[0];
    const consumerEvidencePath = path.resolve(root, consumerEvidenceFile);
    const consumerEvidenceStat = fs.lstatSync(consumerEvidencePath);
    if (!consumerEvidenceStat.isFile() || consumerEvidenceStat.isSymbolicLink())
    {
        throw new Error(`${tier.id} prerequisite consumer evidence is not a regular file`);
    }
    const consumerEvidence = JSON.parse(fs.readFileSync(consumerEvidencePath, 'utf8'));
    return createCurrentRunPreexecutedTierBinding({
        root,
        tierId: tier.id,
        schedulerRunId: normalizedRunId,
        sourceState: normalizedSourceState,
        consumerEvidenceFile,
        consumerEvidence
    });
}

function shouldUseLocalProfile(matrix, tierId, options)
{
    const targetTierId = normalizeTierId(tierId);
    return !isCiEnvironment()
    && options.logicalDag !== true
    && options.noDeps !== true
    && Boolean(matrix.localProfiles?.[targetTierId]);
}

function fileDigest(file)
{
    return `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function writeSummaryOnlyEvidence(profileId, profile, runId, sourceState, artifactTable = null)
{
    const evidence = {};
    for (const tierId of profile.summaryOnly ?? [])
    {
        const outFile = activeProductionFreshOutputRoot
            ? path.join(activeProductionFreshOutputRoot, 'summary', 'summary-only', `${tierId}.json`)
            : path.join(root, `.tmp/local-${profileId}/summary-only/${tierId}.json`);
        const payload = {
            schema: 'fsusblog.local-production.summary-only.v1',
            tierId,
            status: 'collected-blocked',
            executionSource: 'external-environment',
            schedulerRunId: runId,
            sourceState,
            generatedAt: new Date().toISOString()
        };
        fs.mkdirSync(path.dirname(outFile), { recursive: true });
        fs.writeFileSync(outFile, `${JSON.stringify(payload, null, 2)}\n`);
        const evidencePath = relativeToRoot(outFile);
        const artifact = artifactTable?.digestDeclarations([evidencePath], {
            producer: { bundle: 'projection', step: `summary-only/${tierId}` }
        });
        evidence[tierId] = {
            ...payload,
            evidencePath,
            artifactDigest: artifact?.digests[evidencePath] ?? fileDigest(outFile),
            ...(artifact ? { artifactRef: artifact.refs[evidencePath] } : {})
        };
    }
    return evidence;
}

function readDeclaredExternalEvidenceReceipts()
{
    const raw = process.env.FSUSBLOG_EXTERNAL_EVIDENCE_RECEIPTS;
    if (!raw)
    {
        return {};
    }
    let declarations;
    try
    {
        declarations = JSON.parse(raw);
    }
    catch
    {
        throw new Error('FSUSBLOG_EXTERNAL_EVIDENCE_RECEIPTS must be JSON');
    }
    if (!declarations || typeof declarations !== 'object' || Array.isArray(declarations))
    {
        throw new Error('FSUSBLOG_EXTERNAL_EVIDENCE_RECEIPTS must map tier ids to receipt paths');
    }
    const resolved = {};
    for (const [tierId, paths] of Object.entries(declarations))
    {
        if (!Array.isArray(paths))
        {
            throw new Error(`${tierId} external receipt declarations must be an array`);
        }
        resolved[tierId] = paths.map((receiptPath) =>
        {
            if (typeof receiptPath !== 'string' || !receiptPath.trim() || path.isAbsolute(receiptPath))
            {
                throw new Error(`${tierId} external receipt path must be repository-relative`);
            }
            const file = path.resolve(root, receiptPath);
            if (!file.startsWith(`${root}${path.sep}`) || !fs.existsSync(file) || !fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())
            {
                throw new Error(`${tierId} external receipt file is missing or invalid: ${receiptPath}`);
            }
            return { receiptPath, receipt: JSON.parse(fs.readFileSync(file, 'utf8')) };
        });
    }
    return resolved;
}

function withoutDotnetBuildServerRecord(value)
{
    const entry = { ...value };
    delete entry.record;
    return entry;
}

function projectLocalBundleSummaries(matrix, profileId, profile, runId, completedTierIds, runOutputs = null)
{
    const byId = tierMap(matrix);
    const projected = [];
    const bundleSummaries = {};
    for (const bundle of profile.bundles)
    {
        const physicalTierId = `local-${profileId}-${bundle.id}`;
        if (!completedTierIds.has(physicalTierId))
        {
            continue;
        }
        const summaryFile = runOutputs
            ? path.join(runOutputs.outputRoot, 'bundles', bundle.id, 'summary.json')
            : path.join(root, localBundleSummaryPath(profileId, bundle.id));
        const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
        const errors = validateLocalBundleSummary(summary, bundle, { expectedRunId: runId });
        if (errors.length > 0)
        {
            throw new Error(`${bundle.id} bundle evidence invalid: ${errors.join('; ')}`);
        }
        bundleSummaries[bundle.id] = summary;
        for (const tierId of bundle.members)
        {
            const tier = byId.get(tierId);
            const member = summary.members[tierId];
            const startedAt = Date.now() - Math.max(0, Number(member.durationMs) || 0);
            writeJobSummary(matrix, tier, 'success', startedAt, {
                schedulerRunId: runId,
                physicalBundleId: bundle.id,
                executionSource: 'fresh',
                testIds: member.testIds,
                artifactDigests: member.artifactDigests
            });
            projected.push(tierId);
        }
    }
    return { projectedTierIds: projected, bundleSummaries };
}

function localRunSummaryFile(profileId, runOutputs = null)
{
    return runOutputs
        ? path.join(runOutputs.outputRoot, 'summary', 'run.json')
        : path.join(root, `.tmp/local-${profileId}/summary.json`);
}

function emitProductionResourceUtilization({ profileId, profile, result, detectedResources, durationMs, runOutputs = null })
{
    const checkpointFile = result.checkpointPath;
    const checkpoint = JSON.parse(fs.readFileSync(checkpointFile, 'utf8'));
    result.checkpoint = checkpoint;
    const bundles = Object.fromEntries(profile.bundles.map((bundle) =>
    {
        const resourceFile = runOutputs
            ? path.join(runOutputs.outputRoot, 'bundles', bundle.id, 'resource-utilization.json')
            : path.join(root, `.tmp/local-${profileId}`, bundle.id, 'resource-utilization.json');
        const summaryFile = runOutputs
            ? path.join(runOutputs.outputRoot, 'bundles', bundle.id, 'summary.json')
            : path.join(root, localBundleSummaryPath(profileId, bundle.id));
        let resourceUtilization;
        try
        {
            resourceUtilization = JSON.parse(fs.readFileSync(resourceFile, 'utf8'));
        }
        catch
        {
            resourceUtilization = undefined;
        }
        if (resourceUtilization && (resourceUtilization.schedulerRunId !== result.runId
      || resourceUtilization.sourceState?.commit !== checkpoint.sourceState?.commit
      || resourceUtilization.sourceState?.worktreeFingerprint !== checkpoint.sourceState?.worktreeFingerprint))
        {
            throw new Error(`resource utilization fragment binding mismatch: ${bundle.id}`);
        }
        const schedulerProcessTree = checkpoint.tiers?.[`local-${profileId}-${bundle.id}`]?.resourceUtilization ?? null;
        const bundleMetrics = resourceUtilization ? {
      ...resourceUtilization,
      peakRssBytes: schedulerProcessTree?.peakRssBytes ?? resourceUtilization.peakRssBytes,
      averageRssBytes: schedulerProcessTree?.averageRssBytes ?? resourceUtilization.averageRssBytes,
      processSpawnCount: schedulerProcessTree?.processSpawnCount ?? resourceUtilization.processSpawnCount,
      actualCurve: schedulerProcessTree?.samples ?? []
    } : null;
        return [bundle.id, {
            status: resourceUtilization?.status ?? 'unavailable',
            resourceUtilization,
            bundleMetrics,
            bindings: {
                resourceFile: fs.existsSync(resourceFile) ? relativeToRoot(resourceFile) : null,
                resourceDigest: fs.existsSync(resourceFile) ? fileDigest(resourceFile) : null,
                summaryFile: fs.existsSync(summaryFile) ? relativeToRoot(summaryFile) : null,
                summaryDigest: fs.existsSync(summaryFile) ? fileDigest(summaryFile) : null
            }
        }];
    }));
    const bundleValues = Object.values(bundles).map((entry) => entry.bundleMetrics).filter(Boolean);
    const stepValues = bundleValues.flatMap((entry) => Object.entries(entry.steps ?? {})
        .map(([stepId, value]) => ({ ...value, stepId, physicalBundleId: entry.physicalBundleId })));
    const sumFinite = (values) =>
    {
        const selected = values.map(Number).filter(Number.isFinite);
        return selected.length ? selected.reduce((total, value) => total + value, 0) : null;
    };
    const sumComplete = (values) => values.length > 0 && values.every((value) => Number.isFinite(Number(value)))
        ? values.reduce((total, value) => total + Number(value), 0)
        : null;
    const actualCpuSeconds = sumFinite(stepValues.map((entry) => entry.actualCpuSeconds));
    const grantedCpuSeconds = sumComplete(stepValues
        .filter((entry) => entry.status !== 'not-applicable')
        .map((entry) => entry.grantedCpuSeconds));
    const waitTotalsMs = {};
    for (const bundleValue of bundleValues)
    {
        for (const [category, value] of Object.entries(bundleValue.waits?.totalsMs ?? {}))
        {
            waitTotalsMs[category] = (waitTotalsMs[category] ?? 0) + Number(value || 0);
        }
    }
    for (const [category, value] of Object.entries(checkpoint.resourceUtilization?.waits?.totalsMs ?? {}))
    {
        waitTotalsMs[category] = (waitTotalsMs[category] ?? 0) + Number(value || 0);
    }
    const budgetCpu = Number(checkpoint.resourceBudget?.cpuUnits) || Number(detectedResources.availableCpuUnits) || 1;
    const capacityCpuSeconds = budgetCpu * durationMs / 1000;
    const idleCapacitySeconds = actualCpuSeconds === null ? null : Math.max(0, capacityCpuSeconds - actualCpuSeconds);
    const schedulerSamples = checkpoint.resourceUtilization?.samples ?? [];
    let largestIdleInterval = null;
    for (let index = 1; index < schedulerSamples.length; index += 1)
    {
        const previous = schedulerSamples[index - 1];
        const current = schedulerSamples[index];
        const durationSeconds = Math.max(0, Number(current.atMs - previous.atMs) / 1000);
        const idleCpuSeconds = Math.max(0, budgetCpu - Number(previous.reservedCpuUnits || 0)) * durationSeconds;
        if (!largestIdleInterval || idleCpuSeconds > largestIdleInterval.idleCpuSeconds)
        {
            largestIdleInterval = {
                startedAtMs: previous.atMs,
                finishedAtMs: current.atMs,
                idleCpuSeconds,
                reasonBasis: 'unreserved-scheduler-capacity'
            };
        }
    }
    const lowEfficiencySteps = stepValues.filter((entry) => Number.isFinite(entry.cpuGrantEfficiency))
        .sort((left, right) => left.cpuGrantEfficiency - right.cpuGrantEfficiency)
        .slice(0, 5)
        .map(({ physicalBundleId, stepId, cpuGrantEfficiency, actualCpuSeconds: actual, grantedCpuSeconds: granted }) => ({
            physicalBundleId, stepId, cpuGrantEfficiency, actualCpuSeconds: actual, grantedCpuSeconds: granted
        }));
    const warnings = [];
    if (schedulerSamples.some((sample) => Number(sample.reservedCpuUnits) > budgetCpu + 1e-6))
    {
        warnings.push('reserved CPU exceeded scheduler budget');
    }
    if (schedulerSamples.some((sample) => Number(sample.reservedMemoryGiB) > Number(checkpoint.resourceBudget?.memoryGiB) + 1e-6))
    {
        warnings.push('reserved memory exceeded scheduler budget');
    }
    const memoryPressureThreshold = Number(detectedResources.totalMemoryGiB) - Number(detectedResources.memoryReserveGiB || 0);
    if (Number.isFinite(memoryPressureThreshold)
    && schedulerSamples.some((sample) => Number(sample.hostUsedMemoryGiB) > memoryPressureThreshold))
    {
        warnings.push('host memory pressure crossed the machine-derived reserve threshold');
    }
    const complete = result.status === 'success'
    && Object.values(bundles).every((entry) => entry.resourceUtilization?.status === 'complete');
    const expected = { runId: result.runId, sourceState: checkpoint.sourceState, checkpoint: { revision: checkpoint.revision } };
    const evidence = writeResourceUtilizationEvidence(
    runOutputs
        ? path.join(runOutputs.outputRoot, 'release-evidence', 'production-resource-utilization.json')
        : path.join(root, '.tmp/release-evidence/production-resource-utilization.json'),
    {
        status: complete ? 'complete' : 'partial',
        incomplete: !complete,
        runId: result.runId,
        profileId,
        sourceState: checkpoint.sourceState,
        machine: {
            platform: process.platform,
            arch: process.arch,
            cpuCount: detectedResources.cpuCount,
            availableCpuUnits: detectedResources.availableCpuUnits,
            availableMemoryGiB: detectedResources.availableMemoryGiB,
            schedulerBudget: checkpoint.resourceBudget
        },
        checkpoint: {
            path: relativeToRoot(checkpointFile),
            digest: fileDigest(checkpointFile),
            revision: checkpoint.revision,
            status: checkpoint.status
        },
        wallSeconds: durationMs / 1000,
        actualCpuSeconds,
        grantedCpuSeconds,
        cpuGrantEfficiency: actualCpuSeconds === null || grantedCpuSeconds === null || grantedCpuSeconds <= 0
            ? null : actualCpuSeconds / grantedCpuSeconds,
        idleCapacitySeconds,
        scheduler: {
            criticalPath: checkpoint.criticalPath,
            curves: schedulerSamples,
            actualProcessCurves: Object.fromEntries(Object.entries(checkpoint.tiers ?? {})
                .map(([tierId, tier]) => [tierId, tier.resourceUtilization?.samples ?? []])),
            resourceGrantHistory: checkpoint.resourceUtilization?.resourceGrantHistory ?? {},
            waits: checkpoint.resourceUtilization?.waits ?? null,
            largestIdleInterval
        },
        enforcement: checkpoint.resourceEnforcement ?? {
            mode: 'advisory',
            status: 'unavailable',
            reason: 'checkpoint-has-no-enforcement-evidence'
        },
        waits: { totalsMs: waitTotalsMs },
        collectorCalibration: measureResourceCollectorOverhead(),
        lowEfficiencySteps,
        warnings,
        bundles,
        generatedAt: new Date().toISOString()
    },
    expected);
    console.error(`[matrix:${profileId}] resource utilization wall=${evidence.wallSeconds.toFixed(2)}s criticalPath=${evidence.scheduler.criticalPath?.tierIds?.join('->') ?? 'unavailable'}`);
    for (const [bundleId, entry] of Object.entries(bundles))
    {
        const efficiency = entry.bundleMetrics?.cpuGrantEfficiency;
        console.error(`[matrix:${profileId}] utilization bundle=${bundleId} efficiency=${Number.isFinite(efficiency) ? efficiency.toFixed(3) : 'unavailable'}`);
    }
    console.error(`[matrix:${profileId}] idleCapacitySeconds=${Number.isFinite(idleCapacitySeconds) ? idleCapacitySeconds.toFixed(2) : 'unavailable'} largestIdleInterval=${largestIdleInterval?.idleCpuSeconds?.toFixed(2) ?? 'unavailable'}`);
    console.error(`[matrix:${profileId}] waits=${Object.entries(waitTotalsMs).map(([key, value]) => `${key}:${value}ms`).join(',') || 'none'}`);
    console.error(`[matrix:${profileId}] low-efficiency=${lowEfficiencySteps.map((entry) => `${entry.physicalBundleId}/${entry.stepId}:${entry.cpuGrantEfficiency.toFixed(3)}`).join(',') || 'unavailable'} warnings=${warnings.join(';') || 'none'}`);
    return evidence;
}

export async function runLocalProfile(matrix, profileId, options, runtime = {})
{
    const profile = matrix.localProfiles[profileId];
    const correctnessBudgetPolicy = loadCorrectnessBudgetPolicy();
    const profileCorrectnessBudget = correctnessBudgetPolicy.policies
        .find((entry) => entry.tierId === profileId) ?? null;
    const externalEvidenceReceipts = readDeclaredExternalEvidenceReceipts();
    const profileRoot = path.resolve(runtime.root ?? root);
    const resolveRunIdentity = runtime.schedulerRunIdentity ?? schedulerRunIdentity;
    const admissionRunIdentity = runtime.productionFreshRunIdentity
    ?? resolveRunIdentity(profileId, options);
    const productionFresh = ['production-correctness', 'production'].includes(profileId);
    const detectResources = () => runtime.detectedResources ?? localProfileSystemResources(profile, {
        cpuCount: os.availableParallelism?.() ?? os.cpus().length,
        availableMemoryGiB: availableMemoryGiB(),
        load1: process.platform === 'win32' ? 0 : os.loadavg()[0]
    });
    const assertProductionFreshLeaseSourceStable = async () =>
    {
        if (!productionFresh)
        {
            return;
        }
        const expectedSourceState = runtime.productionFreshSourceState;
        const currentSourceState = await (runtime.snapshotSourceState ?? snapshotSourceState)(profileRoot);
        if (typeof expectedSourceState?.commit !== 'string'
      || typeof expectedSourceState?.worktreeFingerprint !== 'string'
      || currentSourceState?.commit !== expectedSourceState.commit
      || currentSourceState?.worktreeFingerprint !== expectedSourceState.worktreeFingerprint)
        {
            const error = new Error(
                'Production Fresh source drifted across lease-bound BehaviorDoc verification');
            error.code = 'PRODUCTION_FRESH_SOURCE_DRIFT';
            throw error;
        }
    };
    const resolveCapacityPlanning = () =>
    {
        if (runtime.productionCapacityPlanning)
        {
            return runtime.productionCapacityPlanning;
        }
        const detectedResources = detectResources();
        const resolvedProfile = resolveLocalProfileResources(profile, detectedResources);
        const launchParallelism = Math.min(
            options.maxParallel ?? detectedResources.launchParallelism,
            detectedResources.launchParallelism);
        const runId = admissionRunIdentity.runId;
        const capacityOutputRoot = path.join(profileRoot, '.tmp', 'test-runs', runId, 'outputs');
        const projectionOnly = productionResumeAuthority?.mode === 'projection-only';
        const physicalTiers = projectionOnly
            ? []
            : createLocalBundleTiers(profileId, resolvedProfile, {
          maxParallel: launchParallelism
        });
        if (!projectionOnly)
        {
            projectLocalBootstrapFixtureProfile(physicalTiers, matrix.tiers);
            projectLocalNonResidentServiceRequirements(physicalTiers, matrix.tiers);
        }
        const capacityTiers = projectionOnly
            ? prependBehaviorDocCapacityAuthority([{
          id: 'logical-projection-resume',
          executionDependsOn: [],
          exclusiveResources: ['projection-finalization'],
          capacityIdentity: productionResumeAuthority.authorityDigest
        }])
            : prependBehaviorDocCapacityAuthority(
          prependManagedProductionBuildGc(physicalTiers, runId, {
            enabled: !options.resume,
            outputRoot: capacityOutputRoot
          }));
        const plan = (runtime.buildProductionDiskDemandPlan ?? buildProductionDiskDemandPlan)({
            root: profileRoot,
            tiers: capacityTiers,
            maxParallel: launchParallelism,
            catalog: runtime.behaviorDocNugetPreparation
                ? bindBehaviorDocNugetDiskDemand(
                    runtime.productionDiskDemandCatalog ?? readProductionDiskDemandCatalog(root),
                    runtime.behaviorDocNugetPreparation)
                : runtime.productionDiskDemandCatalog ?? readProductionDiskDemandCatalog(root),
            roots: (runtime.defaultProductionDiskRoots ?? defaultProductionDiskRoots)(profileRoot, {
                resolveDockerRoot: projectionOnly
                    ? null
                    : (runtime.resolveDockerRoot ?? dockerRootDirectory),
                includeDockerStorage: !projectionOnly,
                outputRoot: capacityOutputRoot,
                buildRoot: path.join(profileRoot, '.tmp', 'build', runId),
                dependencyCacheRoot: path.join(profileRoot, '.tmp', 'dependency-cache'),
                behaviorDocContractBuildCacheRoot: path.join(
                    profileRoot,
                    '.tmp',
                    'behavior-doc-contract-builds'),
                behaviorDocObservationRoot: path.join(profileRoot, '.tmp', 'contracts')
            }),
            ...(runtime.resolveFilesystem ? { resolveFilesystem: runtime.resolveFilesystem } : {})
        });
        return {
            detectedResources,
            resolvedProfile,
            launchParallelism,
            physicalTiers,
            capacityTiers,
            plan
        };
    };
    if (productionFresh && !options.planOnly && runtime.productionFreshLeaseHeld !== true)
    {
        const leaseRunIdentity = admissionRunIdentity;
        const leaseSourceState = await (runtime.snapshotSourceState ?? snapshotSourceState)(profileRoot);
        const lease = acquireProductionFreshExclusiveLease({
            root: profileRoot,
            runId: leaseRunIdentity.runId,
            targetTierId: profileId,
            sourceState: leaseSourceState,
            budgetPolicyDigest: profileCorrectnessBudget
                ? correctnessBudgetPolicyDigest(correctnessBudgetPolicy)
                : null
        });
        let terminalState = 'failed';
        try
        {
            const result = await runLocalProfile(matrix, profileId, options, {
                ...runtime,
                productionFreshLeaseHeld: true,
                productionFreshLeaseOwner: lease.owner,
                productionFreshRunIdentity: leaseRunIdentity,
                productionFreshSourceState: leaseSourceState
            });
            terminalState = result?.status === 'failure' ? 'failed' : 'complete';
            return result;
        }
        catch (error)
        {
            terminalState = ['AbortError', 'CancellationError'].includes(error?.name)
                ? 'cancelled'
                : 'failed';
            throw error;
        }
        finally
        {
            lease.release(terminalState);
        }
    }
    const productionResumeAuthority = productionFresh && options.resume
        ? (runtime.productionResumeAuthority
        ?? readProductionResumeCheckpointAuthority(admissionRunIdentity))
        : null;
    if (productionFresh && !options.planOnly && !runtime.runBehaviorDocStaticAdmission
        && !runtime.behaviorDocNugetPreparation)
    {
        const preparation = await readPreparedBehaviorDocNuget({
            repositoryRoot: profileRoot, runId: admissionRunIdentity.runId,
            file: process.env.FSUSBLOG_BEHAVIOR_DOC_NUGET_PREPARATION
        });
        return runLocalProfile(matrix, profileId, options, {
            ...runtime, behaviorDocNugetPreparation: preparation
        });
    }
    if (productionFresh && !options.planOnly && runtime.productionCapacityReservationHeld !== true)
    {
        const planning = resolveCapacityPlanning();
        const cacheInspection = (runtime.inspectProductionFreshCacheTransactions
      ?? inspectProductionFreshCacheTransactions)(profileRoot);
        console.error(`[matrix:${profileId}] cache transaction read-only inspection journals=${cacheInspection.length}`);
        const acquireReservation = runtime.acquireProductionCapacityReservation
      ?? acquireProductionCapacityReservation;
        const reservation = acquireReservation({
            plan: planning.plan,
            runId: admissionRunIdentity.runId,
            candidateIdentityDigest: runtime.productionFreshLeaseOwner?.candidateIdentityDigest,
            repositoryRoot: profileRoot,
            repositoryLeaseOwner: runtime.productionFreshLeaseOwner,
            ...(runtime.capacityAuthorityRoot ? { authorityRoot: runtime.capacityAuthorityRoot } : {})
        });
        let result;
        let operationError = null;
        try
        {
            result = await runLocalProfile(matrix, profileId, options, {
                ...runtime,
                productionCapacityReservationHeld: true,
                productionCapacityReservation: reservation,
                productionCapacityPlan: planning.plan,
                productionCapacityPlanning: planning,
                productionResumeAuthority
            });
        }
        catch (error)
        {
            operationError = error;
        }
        try
        {
            reservation.release(!operationError && result?.status === 'success' ? 'released' : 'aborted');
        }
        catch (error)
        {
            if (!operationError && result?.status === 'failure')
            {
                result.productionCapacityReleaseError = error;
                console.error(`[matrix:${profileId}] secondary capacity release failure: ${error.message}`);
            }
            else if (!operationError)
            {
                operationError = error;
            }
            else
            {
                console.error(`[matrix:${profileId}] secondary capacity release failure: ${error.message}`);
                if (Object.isExtensible(operationError))
                {
                    operationError.productionCapacityReleaseError = error;
                }
            }
        }
        if (operationError)
        {
            throw operationError;
        }
        return result;
    }
    if (!options.planOnly && runtime.behaviorDocStaticAdmission == null)
    {
        const admissionReceiptFile = runtime.behaviorDocStaticAdmissionReceiptFile
      ?? path.join(
          profileRoot,
          '.tmp/behavior-doc-static-admission',
          createHash('sha256')
              .update(`${profileRoot}\0${admissionRunIdentity.runId}`)
              .digest('hex'),
          'receipt.json'
      );
        const runAdmission = runtime.runBehaviorDocStaticAdmission
      ?? runProtectedBehaviorDocAdmission;
        runtime.productionCapacityReservation?.guardProducer(behaviorDocAdmissionTierId);
        const admission = await runAdmission({
            repositoryRoot: profileRoot,
            runId: admissionRunIdentity.runId,
            outputFile: admissionReceiptFile,
            candidateSpawnCountBeforeReceipt: 0
        });
        await assertProductionFreshLeaseSourceStable();
        runtime.productionCapacityReservation?.completeProducer(behaviorDocAdmissionTierId);
        return runLocalProfile(matrix, profileId, options, {
            ...runtime,
            productionFreshRunIdentity: admissionRunIdentity,
            behaviorDocStaticAdmission: {
                receiptFile: admission.receiptFile,
                runId: admissionRunIdentity.runId,
                contentDigest: admission.receipt.contentDigest
            }
        });
    }
    if (!options.planOnly)
    {
        const admissionState = runtime.behaviorDocStaticAdmission;
        if (!admissionState?.receiptFile || admissionState.runId !== admissionRunIdentity.runId)
        {
            throw new Error('local profile has no run-bound BehaviorDoc static admission receipt');
        }
        const currentSourceState = (runtime.behaviorDocSourceIdentity ?? sealSourceIdentity)(profileRoot);
        const readAdmission = runtime.readBehaviorDocStaticAdmissionReceipt
      ?? readBehaviorDocStaticAdmissionReceipt;
        const receipt = readAdmission(admissionState.receiptFile, {
            expectedRunId: admissionRunIdentity.runId,
            expectedSourceIdentity: currentSourceState,
            expectedWorktree: profileRoot
        });
        if (receipt.contentDigest !== admissionState.contentDigest)
        {
            throw new Error('local profile BehaviorDoc admission receipt digest drifted');
        }
        await assertProductionFreshLeaseSourceStable();
    }
    const resumeIdentity = options.resume
        ? (runtime.productionFreshRunIdentity ?? resolveRunIdentity(profileId, options))
        : null;
    if (resumeIdentity && !options.planOnly)
    {
        assertProductionResumeCheckpointAuthorityStable(productionResumeAuthority, resumeIdentity);
        if (productionResumeAuthority.mode === 'projection-only')
        {
            const checkpointPath = productionResumeAuthority.checkpointPath;
            const resumeCheckpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
            const previousOutputs = resolveProductionFreshOutputAttempt({
                root: profileRoot,
                runId: resumeIdentity.runId,
                attemptId: resumeCheckpoint?.productionFreshOutputAttemptId
            });
            runtime.productionCapacityReservation?.guardProducer('logical-projection-resume');
            const resumeOutputs = createProductionFreshOutputRoot({
                root: profileRoot,
                runId: resumeIdentity.runId,
                resume: true
            });
            const projectionOutputBefore = captureProductionFreshOutputInventory(resumeOutputs);
            let forbiddenOutputObservation;
            try
            {
                forbiddenOutputObservation = beginProductionFreshForbiddenOutputObservation({
                    repositoryRoot: resumeOutputs.repositoryRoot
                });
            }
            catch (error)
            {
                await finalizeProductionFreshAttempt(resumeOutputs, async () =>
                {
                    throw error;
                });
            }
            let forbiddenOutputObservationFinished = false;
            let attemptFinalizationStarted = false;
            let attemptFinalized = false;
            activeProductionFreshOutputRoot = resumeOutputs.outputRoot;
            try
            {
                const detectedResources = detectResources();
                const resolvedLogicalMatrix = {
                    ...matrix,
                    tiers: resolveLogicalTierResources(matrix.tiers, detectedResources)
                };
                const resumeEvidence = runtime.resumeCheckpointEvidence ?? resumeCheckpointEvidence;
                const checkpoint = await resumeEvidence(checkpointPath, resumeIdentity.runId, (successfulCheckpoint) =>
                {
                    if (successfulCheckpoint.logicalTierProjection)
                    {
                        return { logicalTierProjection: successfulCheckpoint.logicalTierProjection };
                    }
                    const completedTierIds = new Set(successfulCheckpoint.completedTiers ?? []);
                    const projectionInput = projectLocalBundleSummaries(
                        resolvedLogicalMatrix,
                        profileId,
                        profile,
                        resumeIdentity.runId,
                        completedTierIds,
                        previousOutputs);
                    const summaryOnlyEvidence = writeSummaryOnlyEvidence(
                        profileId,
                        profile,
                        resumeIdentity.runId,
                        successfulCheckpoint.sourceState);
                    return {
                        logicalTierProjection: buildLocalProfileProjection({
                            profileId,
                            profile,
                            tiers: resolvedLogicalMatrix.tiers,
                            checkpoint: successfulCheckpoint,
                            bundleSummaries: projectionInput.bundleSummaries,
                            summaryOnlyEvidence,
                            externalEvidenceReceipts
                        })
                    };
                }, {
                    root: profileRoot,
                    beforeCommit: async ({ checkpoint: preparedCheckpoint }) =>
                    {
                        const summaryFile = localRunSummaryFile(profileId, resumeOutputs);
                        const summary = JSON.parse(
                            fs.readFileSync(localRunSummaryFile(profileId, previousOutputs), 'utf8'));
                        summary.status = preparedCheckpoint.logicalTierProjection.status;
                        summary.qualificationEligible =
                            preparedCheckpoint.logicalTierProjection.qualificationEligible;
                        summary.executionSource = 'fresh-projection-resume';
                        summary.projectedTierIds = preparedCheckpoint.logicalTierProjection.logicalTierIds;
                        summary.failure = null;
                        summary.failures = [];
                        summary.generatedAt = new Date().toISOString();
                        fs.mkdirSync(path.dirname(summaryFile), { recursive: true });
                        fs.writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`);
                        try
                        {
                            finishProductionFreshForbiddenOutputObservation({
                                observation: forbiddenOutputObservation,
                                layout: resumeOutputs,
                                receiptFile: 'runtime/forbidden-output-observation.json'
                            });
                        }
                        finally
                        {
                            forbiddenOutputObservationFinished = true;
                        }
                        writeProjectionResumeProducerReceipt(resumeOutputs, projectionOutputBefore);
                        verifyProductionFreshPhysicalOutputs(resumeOutputs);
                        attemptFinalizationStarted = true;
                        await finalizeProductionFreshAttempt(resumeOutputs, async () =>
                        {});
                        attemptFinalized = true;
                        runtime.productionCapacityReservation?.completeProducer(
                            'logical-projection-resume');
                    }
                });
                if (!attemptFinalized)
                {
                    throw new Error(
                        'projection-only resume checkpoint committed without terminal output finalization');
                }
                const summary = JSON.parse(
                    fs.readFileSync(localRunSummaryFile(profileId, resumeOutputs), 'utf8'));
                console.error(`[matrix:${profileId}] resumed projection run=${resumeIdentity.runId} tiers=${summary.projectedTierIds.length} checkpoint=${relativeToRoot(checkpointPath)}`);
                return { status: 'success', checkpoint };
            }
            finally
            {
                try
                {
                    if (!attemptFinalizationStarted)
                    {
                        await finalizeProductionFreshAttempt(resumeOutputs, async () =>
                        {
                            if (!forbiddenOutputObservationFinished)
                            {
                                finishProductionFreshForbiddenOutputObservation({
                                    observation: forbiddenOutputObservation,
                                    layout: resumeOutputs,
                                    receiptFile: 'runtime/forbidden-output-observation.json'
                                });
                            }
                        });
                    }
                }
                finally
                {
                    activeProductionFreshOutputRoot = null;
                }
            }
        }
    }
    if (productionFresh && !options.planOnly)
    {
        await runtime.productionCapacityReservation.reconcilePriorBuildResources();
    }
    const wallClockStartedAtMs = Number(
        runtime.wallClockStartedAtMs
      ?? process.env.FSUSBLOG_TEST_INVOCATION_STARTED_AT_MS
      ?? Date.now());
    if (!Number.isFinite(wallClockStartedAtMs) || wallClockStartedAtMs <= 0 || wallClockStartedAtMs > Date.now())
    {
        throw new Error('FSUSBLOG_TEST_INVOCATION_STARTED_AT_MS must be a valid epoch timestamp that is not in the future');
    }
    const preflightRunIdentity = resumeIdentity
    ?? runtime.productionFreshRunIdentity
    ?? resolveRunIdentity(profileId, options);
    const runId = preflightRunIdentity.runId;
    const cleanupSource = runtime.productionFreshSourceState
    ?? await (runtime.snapshotSourceState ?? snapshotSourceState)(profileRoot);
    const capacityPlanning = productionFresh ? resolveCapacityPlanning() : null;
    const detectedResources = capacityPlanning?.detectedResources ?? detectResources();
    const resolvedLogicalMatrix = {
        ...matrix,
        tiers: resolveLogicalTierResources(matrix.tiers, detectedResources)
    };
    const resolvedProfile = capacityPlanning?.resolvedProfile
    ?? resolveLocalProfileResources(profile, detectedResources);
    const launchParallelism = capacityPlanning?.launchParallelism
    ?? Math.min(options.maxParallel ?? detectedResources.launchParallelism, detectedResources.launchParallelism);
    const physicalTiers = capacityPlanning?.physicalTiers
    ?? createLocalBundleTiers(profileId, resolvedProfile, { maxParallel: launchParallelism });
    projectLocalBootstrapFixtureProfile(physicalTiers, resolvedLogicalMatrix.tiers);
    projectLocalNonResidentServiceRequirements(physicalTiers, resolvedLogicalMatrix.tiers);
    if (profileCorrectnessBudget)
    {
        for (const tier of physicalTiers)
        {
            if (!Number.isFinite(Number(tier.budgetMs)) || Number(tier.budgetMs) <= 0)
            {
                throw new Error(`${tier.id} has no bounded scheduler deadline`);
            }
            tier.producerExecutionBudgetMs = Number(tier.budgetMs);
            tier.terminationGraceMs = profileCorrectnessBudget.terminationGraceMs;
            tier.producerTimeoutPhase = 'termination';
            tier.correctnessBudget = {
                ...profileCorrectnessBudget,
                tierId: tier.id,
                producer: tier.command,
                measurementWindowMs: 'not-applicable',
                notApplicableReason: 'local-production-bundle',
                producerExecutionBudgetMs: Number(tier.budgetMs),
                tierSchedulerBudgetMs: Number(tier.budgetMs)
            };
        }
    }
    const resolveCapacityPlan = () => capacityPlanning?.plan ?? resolveCapacityPlanning().plan;
    for (const bundle of resolvedProfile.bundles)
    {
        console.error(`[matrix:${profileId}] resolved bundle=${bundle.id} cpu=${bundle.cpuUnits} memory=${bundle.memoryGiB.toFixed(2)}GiB deadline=${bundle.budgetMs}ms stepMaxParallel=${bundle.stepMaxParallel}`);
    }
    if (options.planOnly)
    {
        printPlan(physicalTiers.map((tier) => ({
            ...tier,
            ciJob: `local-${profileId}`,
            timeoutMinutes: Number.isFinite(Number(tier.budgetMs)) ? Math.ceil(tier.budgetMs / 60_000) : 'observe-only',
            risk: 'critical',
            shardable: false,
            defaultShards: 1
        })));
        const diskPlan = resolveCapacityPlan();
        console.log(JSON.stringify({
            schema: diskPlan.schema,
            planDigest: diskPlan.planDigest,
            producerDeclarationDigest: diskPlan.producerDeclarationDigest,
            filesystems: diskPlan.filesystems,
            rootDemandPeaks: diskPlan.rootDemandPeaks,
            producerDeclarations: diskPlan.producerDeclarations
        }));
        return;
    }
    const currentCapacityPlan = resolveCapacityPlan();
    runtime.productionCapacityReservation?.assertPlan(currentCapacityPlan);

    const { runsRoot } = preflightRunIdentity;
    const runNamespace = namespaceFor({ id: profileId, ciJob: `local-${profileId}` }, null, runId);
    const runtimeCleanupOptions = {
        legacyContainerMinimumAgeMs: profile.budgetMs * 2,
        orphanTerminationGraceMs: profileCorrectnessBudget?.terminationGraceMs
      ?? Math.ceil(profile.budgetMs / 100)
    };
    const preflightCleanup = executeProductionFreshPreflight({
        root: profileRoot,
        profileId,
        profile,
        runId,
        runsRoot,
        runtimeNamespace: runNamespace,
        invocationId: runtime.invocationId ?? summaryInvocationId,
        sourceState: cleanupSource,
        physicalTiers,
        executionSource: options.resume ? 'resume' : 'fresh',
        wallClockStartedAtMs,
        receiptDirectory: runtime.receiptDirectory
      ?? path.join(os.tmpdir(), 'fsusblog-runtime-cleanup-receipts'),
        cleanupOptions: runtimeCleanupOptions,
        cleanupRuntime: runtime.cleanupRuntime,
        additionalCleanup: runtime.additionalCleanup,
        additionalCleanupStage: 'preflight-additional-cleanup'
    });
    const staleCleanup = preflightCleanup.cleanup;
    let preflightReceipt = preflightCleanup.receipt;
    const dotnetBuildServerPreflightPids = preflightCleanup.additionalCleanupResult ?? [];
    console.error(`[matrix:${profileId}] runtime cleanup preflight receipt=${preflightReceipt.file} status=${preflightReceipt.receipt.status}`);
    console.error(`[matrix:${profileId}] stale runtime cleanup namespaces=${staleCleanup.namespaces.length} processes=${staleCleanup.terminatedPids.length} containers=${staleCleanup.removedContainers.length} dotnetBuildServers=${dotnetBuildServerPreflightPids.length}`);
    let freshCleanup;
    try
    {
        assertFreshRuntimeCleanupReceipt(preflightReceipt.receipt);
        freshCleanup = options.resume
            ? null
            : (runtime.cleanLocalProductionOutputs ?? cleanLocalProductionOutputs)(profileRoot, {
          runId,
          ownerIdentity: runtime.productionFreshLeaseOwner
        });
    }
    catch (error)
    {
        recordProductionFreshFailure({
            root,
            profileId,
            profile,
            runId,
            runsRoot,
            runtimeNamespace: runNamespace,
            sourceState: cleanupSource,
            physicalTiers,
            executionSource: options.resume ? 'resume' : 'fresh',
            wallClockStartedAtMs,
            failure: {
                tierId: profileId,
                exitCode: 1,
                reason: `Production Fresh preflight cleanup/evidence binding failed: ${error.message}`
            },
            stage: 'runtime-cleanup-preflight-binding-failed'
        });
        throw error;
    }
    // Fresh cleanup owns .tmp, so create the immutable output root only after
    // cleanup completes.  Creating it earlier would let cleanup delete the very
    // root passed to producers below.
    // Logical artifact declarations remain stable while every physical producer
    // receives the attempt-bound locations below.
    const runOutputs = createProductionFreshOutputRoot({ root: profileRoot, runId, resume: options.resume });
    const schedulerOutputBefore = captureProductionFreshOutputInventory(runOutputs);
    try
    {
        preflightReceipt = bindFreshRuntimeCleanupReceipt({ layout: runOutputs, receipt: preflightReceipt });
    }
    catch (error)
    {
        recordProductionFreshFailure({
            root,
            profileId,
            profile,
            runId,
            runsRoot,
            runtimeNamespace: runNamespace,
            sourceState: cleanupSource,
            physicalTiers,
            executionSource: options.resume ? 'resume' : 'fresh',
            wallClockStartedAtMs,
            failure: {
                tierId: profileId,
                exitCode: 1,
                reason: `Production Fresh preflight evidence binding failed: ${error.message}`
            },
            stage: 'runtime-cleanup-preflight-binding-failed'
        });
        await finalizeProductionFreshAttempt(runOutputs, async () =>
        {
            throw error;
        });
    }
    let forbiddenOutputObservation;
    try
    {
        forbiddenOutputObservation = beginProductionFreshForbiddenOutputObservation({
            repositoryRoot: runOutputs.repositoryRoot
        });
    }
    catch (error)
    {
        await finalizeProductionFreshAttempt(runOutputs, async () =>
        {
            throw error;
        });
    }
    let forbiddenOutputObservationFinished = false;
    const finishForbiddenOutputObservation = () =>
    {
        if (forbiddenOutputObservationFinished)
        {
            return;
        }
        try
        {
            return finishProductionFreshForbiddenOutputObservation({
                observation: forbiddenOutputObservation,
                layout: runOutputs,
                receiptFile: 'runtime/forbidden-output-observation.json'
            });
        }
        finally
        {
            forbiddenOutputObservationFinished = true;
        }
    };
    activeProductionFreshOutputRoot = runOutputs.outputRoot;
    const { sourceState: buildSourceState } = await collectSchedulerSourceState(root);
    let lifecycle;
    try
    {
        lifecycle = await runProductionBuildLifecycle({
            prepareOptions: {
                root,
                runId,
                fresh: !options.resume,
                sourceState: buildSourceState,
                namespace: runNamespace
            },
            async execute({
                afterFinalize,
                buildLayout,
                recordSchedulerResult,
                setFinalization,
                throwIfInterrupted
            })
            {
                runtime.productionCapacityReservation.retainBuildOwner(buildLayout);
                const preparedBuildSourceState = buildLayout.manifest.sourceState;
                const physicalProcessPolicy = loadPhysicalExecutionProcessPolicy();
                const scheduledPhysicalTiers = prependManagedProductionBuildGc(physicalTiers, runId, {
                    enabled: !options.resume,
                    outputRoot: runOutputs.outputRoot
                });
                throwIfInterrupted();
                if (options.resume)
                {
                    console.error(`[matrix:${profileId}] physical resume run=${runId} buildRoot=${path.relative(root, buildLayout.runRoot)}`);
                }
                else
                {
                    console.error(`[matrix:${profileId}] fresh cleanup duration=${freshCleanup.durationMs}ms traversed=${freshCleanup.traversedEntryCount} buildRoot=${path.relative(root, buildLayout.runRoot)}`);
                    console.error(`[matrix:${profileId}] managed stale build GC is a preflight scheduler step currentRun=${runId}`);
                }
                console.error(`[matrix:${profileId}] capacity reservation=${runtime.productionCapacityReservation?.receipt.reservationId} plan=${currentCapacityPlan.planDigest}`);
                console.error(`[matrix:${profileId}] dynamic resources cpu=${detectedResources.availableCpuUnits}/${detectedResources.cpuCount} memory=${detectedResources.availableMemoryGiB.toFixed(1)}GiB reserve=${detectedResources.memoryReserveGiB.toFixed(1)}GiB load1=${detectedResources.load1.toFixed(2)} launchParallelism=${launchParallelism}`);
                let result;
                let runError = null;
                let postflightReceipt = null;
                try
                {
                    prepareNamespaceEnvironmentIfNeeded(
                        physicalTiers,
                        runNamespace,
                        {
                            runId,
                            sourceState: buildSourceState,
                            buildLayout,
                            environment: productionFreshOutputEnvironment(runOutputs, 'namespace-prepare'),
                            consumeProductionBuildArtifacts: false
                        });
                    result = recordSchedulerResult(await runDag({
                        registerManagedProcess: (identity, _tier, authority) =>
                            registerProductionBuildCompiler(buildLayout, identity, authority),
                        retainManagedContainment: (authority) => retainProductionBuildServiceContainment(buildLayout, authority),
                        markManagedContainmentCreationAttempt: (authority, _tier, creationSender) =>
                            markProductionBuildServiceCreationAttempt(buildLayout, authority, creationSender),
                        transferManagedResidentService: (authority, transfer) =>
                            transferProductionBuildResidentService(buildLayout, authority, transfer),
                        settleManagedResidentService: (authority, options) =>
                            settleProductionBuildResidentService(buildLayout, authority, options),
                        sourceState: buildSourceState,
                        namespace: runNamespace,
                        tiers: scheduledPhysicalTiers,
                        root,
                        runsRoot,
                        runId,
                        runtimeNamespace: runNamespace,
                        targetTierId: profileId,
                        budgetPolicyDigest: profileCorrectnessBudget ? correctnessBudgetPolicyDigest(correctnessBudgetPolicy) : null,
                        mode: options.resume ? 'resume' : 'fresh',
                        resume: options.resume,
                        ...(options.resume ? {} : {
        freshRunDirectoryPreservation:
          productionFreshSchedulerRunDirectoryPreservation(runOutputs)
      }),
                        maxParallel: launchParallelism,
                        wallClockBudgetMs: options.resume
                            ? null
                            : profileCorrectnessBudget?.profileGlobalBudgetMs ?? profile.budgetMs,
                        wallClockStartedAtMs,
                        collectFailures: true,
                        beforeTierStart: async (tier) =>
                        {
                            const admissionState = runtime.behaviorDocStaticAdmission;
                            const readAdmission = runtime.readBehaviorDocStaticAdmissionReceipt
          ?? readBehaviorDocStaticAdmissionReceipt;
                            const currentSourceIdentity = (runtime.behaviorDocSourceIdentity
          ?? sealSourceIdentity)(profileRoot);
                            const receipt = readAdmission(admissionState.receiptFile, {
                                expectedRunId: admissionState.runId,
                                expectedSourceIdentity: currentSourceIdentity,
                                expectedWorktree: profileRoot
                            });
                            if (receipt.contentDigest !== admissionState.contentDigest)
                            {
                                throw new Error('local profile BehaviorDoc admission receipt digest drifted before spawn');
                            }
                            runtime.productionCapacityReservation?.assertPlan(resolveCapacityPlan());
                            return runtime.productionCapacityReservation?.guardProducer(tier.id);
                        },
                        afterTierSettled: async (tier) =>
                            runtime.productionCapacityReservation?.completeProducer(tier.id),
                        reuseAcrossSourceChanges: false,
                        resourceEnforcementMode: scheduledPhysicalTiers.some((tier) => tier.services?.includes('mysql'))
                            ? 'strict' : process.env.FSUSBLOG_CGROUP_ENFORCEMENT ?? 'auto',
                        resourceEnforcementOptions: { systemdBoundary: {
                            commandBudgetMs: physicalProcessPolicy.systemdControlCommandTimeoutMs,
                            startupBudgetMs: physicalProcessPolicy.systemdResourceStartupTimeoutMs,
                            retainBinding: (reference) => retainProductionBuildResourceBoundary(buildLayout, reference, {
                                commandBudgetMs: physicalProcessPolicy.systemdControlCommandTimeoutMs
                            })
                        } },
                        systemResources: detectedResources,
                        teeOutput: true,
                        onSourceState(sourceState)
                        {
                            if (options.resume
          && (preparedBuildSourceState?.commit !== sourceState.commit
            || preparedBuildSourceState?.worktreeFingerprint !== sourceState.worktreeFingerprint))
                            {
                                fs.rmSync(path.join(buildLayout.generatedRoot, 'artifact-digest-table.json'), { force: true });
                                const removedCoordination = resetResumeRunCoordination(runsRoot, runId);
                                console.error(`[matrix:${profileId}] resume source changed; reset run-bound artifact digest table and ${removedCoordination.length} coordination file(s)`);
                            }
                            bindScheduledBuildLayoutSource(buildLayout, sourceState);
                        },
                        envForTier(tier)
                        {
                            const outputEnvironment = productionFreshEnvironmentForPhysicalTier(runOutputs, tier);
                            assertProductionFreshProducerConfiguration(runOutputs, outputEnvironment);
                            const env = applyNamespaceBuildEnvironment(tier, productionBuildEnvironment(buildLayout, {
                                ...loadNamespaceEnv(runNamespace),
                                CURRENT_TIER: tier.id,
                                MATRIX_JOB: `local-${profileId}`,
                                FSUSBLOG_TEST_NAMESPACE: runNamespace,
                                FSUSBLOG_TEST_RUN_ID: runId,
                                FSUSBLOG_TEST_EXECUTION_SOURCE: options.resume ? 'resume' : 'fresh',
                                FSUSBLOG_LOCAL_PROFILE: profileId,
                                FSUSBLOG_BEHAVIOR_DOC_ADMISSION_RECEIPT: runtime.behaviorDocStaticAdmission.receiptFile,
                                FSUSBLOG_BEHAVIOR_DOC_ADMISSION_DIGEST: runtime.behaviorDocStaticAdmission.contentDigest,
                                FSUSBLOG_BEHAVIOR_DOC_ADMISSION_RUN_ID: runtime.behaviorDocStaticAdmission.runId,
                                ...outputEnvironment,
                                FSUSBLOG_PHYSICAL_BUNDLE_ID: tier.physicalBundleId,
                                FSUSBLOG_DOTNET_BUILD_PARALLELISM: 'auto',
                                FSUSBLOG_BACKEND_COVERAGE_LINE_THRESHOLD: '80.3998',
                                FSUSBLOG_BACKEND_COVERAGE_BRANCH_THRESHOLD: '59.4028',
                                FSUSBLOG_FRONTEND_COVERAGE_LINE_THRESHOLD: '27.78',
                                FSUSBLOG_FRONTEND_COVERAGE_BRANCH_THRESHOLD: '23.48',
                                FSUSBLOG_COVERAGE_LINE_THRESHOLD: '43.6405',
                                FSUSBLOG_COVERAGE_BRANCH_THRESHOLD: '31.7961'
                            }));
                            Object.assign(env, resourceEnvironmentForTier(tier, env));
                            return applyMatrixFixtureProfileEnvironment(tier, env);
                        },
                        onTierStart(tier)
                        {
                            const budgetLabel = Number.isFinite(Number(tier.budgetMs)) ? `${tier.budgetMs}ms` : 'observe-only';
                            console.error(`[matrix:${profileId}] bundle=${tier.physicalBundleId} budget=${budgetLabel} command=${tier.command}`);
                        }
                    }));

                    let projectedTierIds = [];
                    const completedTierIds = new Set(result.checkpoint.completedTiers ?? []);
                    if (result.status === 'success' && !options.resume)
                    {
                        try
                        {
                            const expectedRevision = result.checkpoint.revision;
                            const buildProjectionEvidence = (lockedCheckpoint) =>
                            {
                                const lockedCompletedTierIds = new Set(lockedCheckpoint.completedTiers ?? []);
                                const projectionInput = projectLocalBundleSummaries(
                                    resolvedLogicalMatrix,
                                    profileId,
                                    profile,
                                    runId,
                                    lockedCompletedTierIds,
                                    runOutputs);
                                const artifactTable = createArtifactDigestTable({
                                    root,
                                    file: path.join(buildLayout.generatedRoot, 'artifact-digest-table.json'),
                                    runId,
                                    sourceState: lockedCheckpoint.sourceState
                                });
                                const summaryOnlyEvidence = writeSummaryOnlyEvidence(
                                    profileId,
                                    profile,
                                    runId,
                                    lockedCheckpoint.sourceState,
                                    artifactTable);
                                const artifactDigestTable = artifactTable.finalize(
                                    path.join(runOutputs.outputRoot, 'release-evidence', 'production-artifact-digest-table.json'));
                                const logicalTierProjection = buildLocalProfileProjection({
                                    profileId,
                                    profile,
                                    tiers: resolvedLogicalMatrix.tiers,
                                    checkpoint: lockedCheckpoint,
                                    bundleSummaries: projectionInput.bundleSummaries,
                                    summaryOnlyEvidence,
                                    externalEvidenceReceipts,
                                    artifactDigestTable
                                });
                                return { logicalTierProjection };
                            };
                            result.checkpoint = await attachCheckpointEvidence(
                                result.checkpointPath,
                                runId,
                                buildProjectionEvidence,
                                { root, expectedRevision }
                            );
                            projectedTierIds = result.checkpoint.logicalTierProjection.logicalTierIds;
                        }
                        catch (error)
                        {
                            result.status = 'failure';
                            result.failure = { tierId: profileId, exitCode: 1, reason: error.message };
                        }
                    }
                    const ungeneratedTierIds = profile.bundles
                        .filter((bundle) => !completedTierIds.has(`local-${profileId}-${bundle.id}`))
                        .flatMap((bundle) => bundle.members);
                    result.checkpoint = recordCheckpointRuntimeCleanup(result.checkpointPath, runId, {
                        preflight: {
                            path: relativeToRoot(preflightReceipt.file),
                            status: preflightReceipt.receipt.status,
                            digest: preflightReceipt.receipt.contentDigest
                        }
                    });
                    const summaryFile = localRunSummaryFile(profileId, runOutputs);
                    fs.mkdirSync(path.dirname(summaryFile), { recursive: true });
                    const projection = result.checkpoint.logicalTierProjection;
                    const externalEntries = Object.values(projection?.entries ?? {}).filter((entry) => entry.evidenceKind === 'external-executed');
                    if (projection?.status === 'complete-success'
      && (!projection.qualificationEligible || Object.values(projection.entries ?? {}).some((entry) => entry.evidenceKind === 'summary-only')
        || externalEntries.some((entry) => !entry.authorityId || !entry.buildIdentity || !entry.blockedPlaceholder)))
                    {
                        throw new Error('quality summary refuses an unqualified or summary-only complete-success projection');
                    }
                    const summary = {
                        schema: 'fsusblog.local-production.run.v1',
                        status: projection?.status
        ?? (result.status === 'success' ? 'complete-success' : 'complete-failure'),
                        qualificationEligible: projection?.qualificationEligible ?? false,
                        executionSource: options.resume ? 'resume' : 'fresh',
                        schedulerRunId: runId,
                        budgetMs: profile.budgetMs,
                        durationMs: Math.max(0, Date.now() - wallClockStartedAtMs),
                        physicalBundles: physicalTiers.map((tier) => ({
                            id: tier.physicalBundleId,
                            status: result.checkpoint.tiers?.[tier.id]?.status ?? 'not-run',
                            durationMs: result.checkpoint.tiers?.[tier.id]?.durationMs ?? 0
                        })),
                        projectedTierIds,
                        summaryOnlyTierIds: profile.summaryOnly ?? [],
                        ungeneratedTierIds,
                        failure: result.failure ?? null,
                        failures: result.checkpoint.failures ?? (result.failure ? [result.failure] : []),
                        runtimeCleanup: {
                            preflight: {
                                path: relativeToRoot(preflightReceipt.file),
                                status: preflightReceipt.receipt.status,
                                digest: preflightReceipt.receipt.contentDigest
                            }
                        },
                        generatedAt: new Date().toISOString()
                    };
                    const summaryDurationErrors = validateLocalProfileRunSummary(summary, profile);
                    if (summaryDurationErrors.length > 0 && summary.status === 'success')
                    {
                        summary.status = 'failure';
                        summary.failure = { tierId: profileId, exitCode: 124, reason: summaryDurationErrors.join('; ') };
                        result.status = 'failure';
                        result.failure = summary.failure;
                    }
                    fs.writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`);

                    console.error(`[matrix:${profileId}] run=${result.runId} checkpoint=${relativeToRoot(result.checkpointPath)} summary=${relativeToRoot(summaryFile)}`);
                }
                catch (error)
                {
                    runError = error;
                    throw error;
                }
                finally
                {
                    let finalizationError = null;
                    if (runError !== null || !result)
                    {
                        const failure = {
                            tierId: profileId,
                            exitCode: 1,
                            reason: runError?.message ?? 'Production Fresh scheduler failed before producing a run result'
                        };
                        const checkpointPath = result?.checkpointPath ?? path.join(runsRoot, runId, 'checkpoint.json');
                        const checkpoint = recordCheckpointFailure(checkpointPath, runId, failure, {
                            targetTierId: profileId,
                            sourceState: cleanupSource,
                            runtimeNamespace: runNamespace,
                            startedAt: new Date(wallClockStartedAtMs).toISOString(),
                            stage: 'local-production-run-failed',
                            eventType: 'local-production-run-failed',
                            step: 'scheduler'
                        });
                        result = {
                            ...(result ?? {}),
                            status: 'failure',
                            failure: result?.failure ?? failure,
                            checkpoint,
                            checkpointPath,
                            runId
                        };
                    }
                    const cleanupFile = path.join(runOutputs.outputRoot, 'runtime', 'runtime-cleanup.json');
                    let postflightCleanup = null;
                    try
                    {
                        const namespaceEnvironment = {
                            ...loadNamespaceEnv(runNamespace),
                            ...productionFreshOutputEnvironment(runOutputs, profileId)
                        };
                        let sensitiveFixtureFailure = null;
                        try
                        {
                            cleanupSensitiveFixtures(runNamespace, namespaceEnvironment);
                        }
                        catch (error)
                        {
                            sensitiveFixtureFailure = error;
                        }
                        // Every managed bundle has settled before this finally block. Only the
                        // current run's identity-bound compiler servers are eligible; a global
                        // dotnet build-server shutdown would also stop IDEs and sibling repos.
                        let dotnetBuildServerPostflightPids = [];
                        let dotnetBuildServerPostflightInventoryBeforeCleanup = [];
                        let dotnetBuildServerPostflightInventory = [];
                        let dotnetBuildServerPostflightFailure = null;
                        try
                        {
                            const inventoryOptions = {
                                root,
                                currentRunId: runId,
                                currentNamespace: runNamespace,
                                currentStartSource: options.resume ? 'resume' : 'fresh',
                                runsRoot
                            };
                            dotnetBuildServerPostflightInventoryBeforeCleanup = dotnetBuildServerInventory(
                                discoverOrphanDotnetBuildServers({ root }),
                                inventoryOptions);
                            dotnetBuildServerPostflightPids = cleanupOrphanDotnetBuildServers({
                                ...inventoryOptions,
                                includeCurrentBinding: true,
                                terminationGraceMs: Math.ceil(profile.budgetMs / 100)
                            });
                            dotnetBuildServerPostflightInventory = dotnetBuildServerInventory(
                                discoverOrphanDotnetBuildServers({ root }),
                                inventoryOptions);
                        }
                        catch (error)
                        {
                            dotnetBuildServerPostflightFailure = error;
                        }
                        postflightCleanup = runProductionFreshRuntimeCleanupPhase({
                            root,
                            phase: 'postflight',
                            source: cleanupSource,
                            preflightSource: cleanupSource,
                            currentRunId: runId,
                            runsRoot,
                            cleanupOptions: runtimeCleanupOptions
                        });
                        if (sensitiveFixtureFailure !== null)
                        {
                            postflightCleanup = appendFreshRuntimeCleanupFailure(
                                postflightCleanup,
                                sensitiveFixtureFailure,
                                'postflight-sensitive-fixture-cleanup');
                        }
                        if (dotnetBuildServerPostflightFailure !== null)
                        {
                            postflightCleanup = appendFreshRuntimeCleanupFailure(
                                postflightCleanup,
                                dotnetBuildServerPostflightFailure,
                                'postflight-dotnet-build-server-cleanup');
                        }
                        if (dotnetBuildServerPostflightInventory.some((entry) =>
                            entry.runId === runId && entry.namespace === runNamespace))
                        {
                            postflightCleanup = appendFreshRuntimeCleanupFailure(
                                postflightCleanup,
                                new Error('current-run dotnet build-server inventory was not empty before postflight termination'),
                                'postflight-dotnet-build-server-inventory');
                        }
                        const postflightSource = await snapshotSourceState(root);
                        postflightCleanup = {
                            ...postflightCleanup,
                            sourceStateMatchesPreflight: postflightSource.commit === cleanupSource.commit
          && postflightSource.worktreeFingerprint === cleanupSource.worktreeFingerprint
                        };
                        postflightReceipt = writeFreshRuntimeCleanupReceipt({
                            root,
                            phase: 'postflight',
                            runId,
                            invocationId: summaryInvocationId,
                            source: postflightSource,
                            cleanup: postflightCleanup,
                            directory: path.join(os.tmpdir(), 'fsusblog-runtime-cleanup-receipts')
                        });
                        console.error(`[matrix:${profileId}] runtime cleanup postflight receipt=${postflightReceipt.file} status=${postflightReceipt.receipt.status}`);
                        postflightReceipt = bindFreshRuntimeCleanupReceipt({
                            layout: runOutputs,
                            receipt: postflightReceipt
                        });
                        let postflightFailure = null;
                        if (postflightReceipt.verification.status !== 'complete')
                        {
                            postflightFailure = {
                                tierId: profileId,
                                exitCode: 1,
                                reason: `Production Fresh runtime cleanup postflight blocked: ${postflightReceipt.verification.failures.join('; ')}`
                            };
                            result.status = 'failure';
                            result.failure ??= postflightFailure;
                        }
                        result.checkpoint = recordCheckpointRuntimeCleanup(result.checkpointPath, runId, {
                            ...(result.checkpoint.runtimeCleanup ?? {}),
                            postflight: runtimeCleanupReceiptReference(root, postflightReceipt)
                        }, postflightFailure);
                        fs.mkdirSync(path.dirname(cleanupFile), { recursive: true });
                        fs.writeFileSync(cleanupFile, `${JSON.stringify({
                            ...postflightCleanup,
                            receipt: runtimeCleanupReceiptReference(root, postflightReceipt),
                            dotnetBuildServer: {
                                status: dotnetBuildServerPostflightFailure === null ? 'complete' : 'failed',
                                error: dotnetBuildServerPostflightFailure?.message ?? null,
                                preflightOrphanPids: dotnetBuildServerPreflightPids,
                                postflightOrphanPids: dotnetBuildServerPostflightPids,
                                postflightInventoryBeforeCleanup: dotnetBuildServerPostflightInventoryBeforeCleanup
                                    .map(withoutDotnetBuildServerRecord),
                                postflightInventory: dotnetBuildServerPostflightInventory
                                    .map(withoutDotnetBuildServerRecord)
                            },
                            generatedAt: new Date().toISOString()
                        }, null, 2)}\n`);
                    }
                    catch (error)
                    {
                        finalizationError = error;
                        const failure = {
                            tierId: profileId,
                            exitCode: 1,
                            reason: `Production Fresh runtime cleanup finalization failed: ${error.message}`
                        };
                        result.status = 'failure';
                        result.failure ??= failure;
                        result.checkpoint = recordCheckpointFailure(result.checkpointPath, runId, failure, {
                            targetTierId: profileId,
                            sourceState: cleanupSource,
                            runtimeNamespace: runNamespace,
                            stage: 'runtime-cleanup-finalization-failed',
                            eventType: 'runtime-cleanup-finalization-failed',
                            step: 'runtime-cleanup'
                        });
                    }
                    if (runError !== null || finalizationError !== null)
                    {
                        const summaryFile = localRunSummaryFile(profileId, runOutputs);
                        const summary = {
                            schema: 'fsusblog.local-production.run.v1',
                            status: 'failure',
                            executionSource: options.resume ? 'resume' : 'fresh',
                            schedulerRunId: runId,
                            budgetMs: profile.budgetMs,
                            durationMs: Math.max(0, Date.now() - wallClockStartedAtMs),
                            physicalBundles: physicalTiers.map((tier) => ({
                                id: tier.physicalBundleId,
                                status: result.checkpoint.tiers?.[tier.id]?.status ?? 'not-run',
                                durationMs: result.checkpoint.tiers?.[tier.id]?.durationMs ?? 0
                            })),
                            projectedTierIds: [],
                            summaryOnlyTierIds: profile.summaryOnly ?? [],
                            ungeneratedTierIds: profile.bundles.flatMap((bundle) => bundle.members),
                            failure: result.failure,
                            failures: result.checkpoint.failures,
                            runtimeCleanup: result.checkpoint.runtimeCleanup,
                            generatedAt: new Date().toISOString()
                        };
                        fs.mkdirSync(path.dirname(summaryFile), { recursive: true });
                        fs.writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`);
                    }
                    if (postflightCleanup !== null)
                    {
                        console.error(`[matrix:${profileId}] runtime cleanup=${relativeToRoot(cleanupFile)} containers=${postflightCleanup.removedContainers?.length ?? 0}`);
                    }
                }

                afterFinalize(() =>
                {
                    try
                    {
                        const release = runtime.productionCapacityReservation.release(
      result.status === 'success' ? 'released' : 'aborted');
                        result.checkpoint = recordCheckpointProductionCapacityReservation(
                            result.checkpointPath,
                            runId,
                            {
                                reservationId: runtime.productionCapacityReservation.receipt.reservationId,
                                planDigest: currentCapacityPlan.planDigest,
                                producerDeclarationDigest: currentCapacityPlan.producerDeclarationDigest,
                                releaseReceiptFile: path.resolve(release.file),
                                releaseReceiptDigest: fileDigest(release.file),
                                status: release.receipt.state
                            });
                    }
                    catch (error)
                    {
                        const capacityFailure = {
                            tierId: profileId,
                            exitCode: 1,
                            reason: `Production capacity reservation release failed: ${error.message}`
                        };
                        result.status = 'failure';
                        result.failure ??= capacityFailure;
                        result.checkpoint = recordCheckpointFailure(
                            result.checkpointPath,
                            runId,
                            capacityFailure,
                            {
                                targetTierId: profileId,
                                sourceState: cleanupSource,
                                runtimeNamespace: runNamespace,
                                stage: 'capacity-reservation-release-failed',
                                eventType: 'capacity-reservation-release-failed',
                                step: 'capacity-reservation'
                            });
                    }
                    const summaryFile = localRunSummaryFile(profileId, runOutputs);
                    if (fs.existsSync(summaryFile))
                    {
                        const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
                        summary.status = result.status;
                        summary.failure = result.failure ?? null;
                        summary.failures = result.checkpoint.failures ?? [];
                        summary.productionCapacityReservation = result.checkpoint.productionCapacityReservation ?? null;
                        fs.writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`);
                    }
                });
                const completedAtMs = Date.now();
                const fullScriptDurationMs = Math.max(0, completedAtMs - wallClockStartedAtMs);
                const summaryFile = localRunSummaryFile(profileId, runOutputs);
                if (!options.resume && profile.enforceBudget !== false && fullScriptDurationMs > profile.budgetMs)
                {
                    const wallClockFailure = {
                        tierId: profileId,
                        exitCode: 124,
                        signal: null,
                        reason: `full ./tools/test.sh ${profileId} wall-clock budget exceeded (${fullScriptDurationMs}/${profile.budgetMs}ms)`,
                        changedPaths: []
                    };
                    result.checkpoint = markCheckpointWallClockTimeout(
                        result.checkpointPath,
                        wallClockFailure,
                        new Date(completedAtMs).toISOString());
                    result.status = 'failure';
                    result.failure ??= wallClockFailure;
                }
                if (fs.existsSync(summaryFile))
                {
                    const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
                    summary.durationMs = fullScriptDurationMs;
                    summary.status = result.status;
                    summary.failure = result.failure ?? null;
                    summary.failures = result.checkpoint.failures ?? (result.failure ? [result.failure] : []);
                    summary.productionCapacityReservation = result.checkpoint.productionCapacityReservation ?? null;
                    if (postflightReceipt !== null)
                    {
                        summary.runtimeCleanup.postflight = {
                            path: relativeToRoot(postflightReceipt.file),
                            status: postflightReceipt.receipt.status,
                            digest: postflightReceipt.receipt.contentDigest
                        };
                    }
                    summary.generatedAt = new Date(completedAtMs).toISOString();
                    fs.writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`);
                }

                setFinalization({
                    status:
                    result.status === 'success' ? 'success' : result.failure?.signal ? 'cancelled' : 'failure',
                    cleanup: freshCleanup,
                    wallClockMs: fullScriptDurationMs,
                    completedAt: new Date(completedAtMs).toISOString(),
                    primaryFailure: result.status === 'success' ? null : result.failure
                });
                afterFinalize((buildManifest) =>
                {
                    const buildEvidenceFile = options.resume
                        ? path.join(runOutputs.outputRoot, 'summary', 'resume-build-layout.json')
                        : path.join(runOutputs.outputRoot, 'release-evidence', 'production-build-layout.json');
                    fs.mkdirSync(path.dirname(buildEvidenceFile), { recursive: true });
                    fs.writeFileSync(buildEvidenceFile, `${JSON.stringify(buildManifest, null, 2)}\n`);

                    if (options.resume)
                    {
                    // A physical resume can combine unchanged fresh outputs with newly rerun
                    // bundles. Its checkpoint records that reuse, but it must not replace the
                    // same-source, all-fresh resource evidence consumed by release gates.
                        if (fs.existsSync(summaryFile))
                        {
                            const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
                            summary.resourceUtilization = {
                                path: relativeToRoot(result.checkpointPath),
                                status: result.checkpoint.resourceUtilization?.status ?? 'unavailable',
                                digest: fileDigest(result.checkpointPath),
                                authoritative: false
                            };
                            fs.writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`);
                        }
                    }
                    else
                    {
                        const resourceUtilizationEvidence = emitProductionResourceUtilization({
                            profileId,
                            profile: resolvedProfile,
                            result,
                            detectedResources,
                            durationMs: fullScriptDurationMs,
                            runOutputs
                        });
                        if (fs.existsSync(summaryFile))
                        {
                            const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
                            summary.resourceUtilization = {
                                path: relativeToRoot(path.join(
                                    runOutputs.outputRoot,
                                    'release-evidence',
                                    'production-resource-utilization.json'
                                )),
                                status: resourceUtilizationEvidence.status,
                                digest: fileDigest(
                                    path.join(
                                        runOutputs.outputRoot,
                                        'release-evidence',
                                        'production-resource-utilization.json'
                                    )
                                )
                            };
                            fs.writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`);
                        }
                    }
                });
                return result;
            }
        });
    }
    catch (error)
    {
        try
        {
            await finalizeProductionFreshAttempt(runOutputs, async () =>
            {
                finishForbiddenOutputObservation();
                throw error;
            });
        }
        finally
        {
            activeProductionFreshOutputRoot = null;
        }
    }
    const result = lifecycle.operationResult;
    try
    {
        await finalizeProductionFreshAttempt(runOutputs, async () =>
        {
            finishForbiddenOutputObservation();
            writeSchedulerProducerReceipts(runOutputs, schedulerOutputBefore, {
                runStatus: result.status,
                checkpoint: result.checkpoint
            });
            verifyProductionFreshPhysicalOutputs(runOutputs, {
                runStatus: result.status
            });
        });
    }
    finally
    {
        activeProductionFreshOutputRoot = null;
    }
    if (result.status !== 'success')
    {
        const failures =
            result.checkpoint.failures?.length > 0
                ? result.checkpoint.failures
                : [result.failure ?? { tierId: profileId, reason: 'local profile failed' }];
        console.error(`[matrix:${profileId}] ${failures.length} independent failure(s) collected`);
        for (const failure of failures)
        {
            console.error(
                `[matrix:${failure.tierId ?? profileId}] ${failure.reason ?? 'local profile failed'}`
            );
        }
        process.exitCode = Number(result.failure?.exitCode) || 1;
    }
    return result;
}

function resetFreshJobSummaries(entries)
{
    for (const [tier, details] of entries)
    {
        const jobId = summaryJobIdForTier(tier, details);
        const existing = readExistingJobSummary(jobId);
        if (ciSummaryAuthorityId && existing?.schedulerRunId === ciSummaryAuthorityId)
        {
            continue;
        }
        fs.rmSync(jobSummaryPath(jobId), { force: true });
    }
}

function emitTierReproductionHint(tier, options)
{
    console.error(`[matrix:${tier.id}] To reproduce tier locally: ${tierReproductionCommand(tier, options)}`);
    console.error(`[matrix:${tier.id}] To reproduce CI job locally: ${ciJobReproductionCommand(tier.ciJob)}`);
}

const sourceCoordinationTierIds = new Set(['validate-declarations', 'pr-smart-gate-plan', 'source-governance']);

function requireGlobalSourceDeclarations(matrix)
{
    const errors = [...validateImpactDeclarations(matrix), ...validateMatrixSchema(matrix)];
    if (errors.length)
    {
        throw new Error(errors.join('\n'));
    }
}

async function runSourceCoordinationTier(matrix, id, args = [], callerContext = null)
{
    if (args.includes('--plan-only'))
    {
        printPlan(planTier(matrix, id), matrix);
        return;
    }
    requireGlobalSourceDeclarations(matrix);
    if (id === 'validate-declarations')
    {
        console.log('[matrix] source declarations validated; execution qualification remains unrun');
        return;
    }
    if (id === 'pr-smart-gate-plan')
    {
        // This original lane only reads actual Git and calls the bound planner.
        const result = spawnSync('bash', ['tools/test/lanes/plan-pr-risk.sh'], { cwd: root, env: process.env, stdio: 'inherit' });
        if (result.error || result.status !== 0)
        {
            throw new Error('bound PR source plan failed');
        }
        return;
    }
    if (id !== 'source-governance')
    {
        throw new Error(`unknown source coordination tier: ${id}`);
    }
    if (!args.includes('--no-deps'))
    {
        await runSourceCoordinationTier(matrix, 'pr-smart-gate-plan');
    }
    await loadSelectedTierIds(matrix, '.tmp/pr-plan.json', callerContext ?? prImpactCallerContext());
    const sourceContext = callerContext ?? prImpactCallerContext();
    const result = spawnSync(process.execPath, ['tools/test-matrix/source-governance.mjs'], { cwd: root,
        env: { ...process.env, FSUSBLOG_BASE_REF: sourceContext.baseRef, FSUSBLOG_PR_EVENT_NAME: sourceContext.eventName,
            ...prImpactConsumerEnvironment(sourceContext) }, stdio: 'inherit' });
    if (result.error || result.status !== 0)
    {
        throw new Error('applicable source governance failed; qualification remains unrun');
    }
}

async function runTier(matrix, tierId, args)
{
    if (sourceCoordinationTierIds.has(normalizeTierId(tierId)))
    {
        await runSourceCoordinationTier(matrix, normalizeTierId(tierId), args);
        return;
    }
    const options = parseRunOptions(args);
    if (shouldUseLocalProfile(matrix, tierId, options))
    {
        await runLocalProfile(matrix, normalizeTierId(tierId), options);
        return;
    }
    const targetTierId = normalizeTierId(tierId);
    const declaredTiers = options.noDeps
        ? [tierMap(matrix).get(normalizeTierId(tierId))]
        : planTier(matrix, tierId);
    if (declaredTiers.some((tier) => !tier))
    {
        throw new Error(`unknown tier: ${tierId}`);
    }
    const systemResources = logicalTierSystemResources();
    const budgetPolicy = loadCorrectnessBudgetPolicy();
    const budgetPolicyBinding = bindBudgetPolicy({}, {}, budgetPolicy);
    let all = applyCorrectnessBudgetPolicy(applyDirectCorrectnessBudgetPolicy(
        resolveLogicalTierResources(declaredTiers, systemResources),
        targetTierId
    ), budgetPolicy);

    if (options.shard)
    {
        const target = all[all.length - 1];
        if (!target.shardable)
        {
            throw new Error(`${target.id} is not shardable`);
        }
        if (!/^\d+\/\d+$/.test(options.shard))
        {
            throw new Error('--shard must use i/n format');
        }
    }

    if (options.planOnly)
    {
        printPlan(all, matrix);
        return;
    }

    const target = all[all.length - 1];
    const { runsRoot, runId } = schedulerRunIdentity(targetTierId, options);
    const { sourceState: buildSourceState } = await collectSchedulerSourceState(root);
    const currentRunPreexecutedTierBindings = [];
    if (targetTierId === behaviorDocAdmissionTierId)
    {
        requireGlobalSourceDeclarations(matrix);
        const admission = await establishBehaviorDocAdmission({
            repositoryRoot: root,
            runId,
            outputFile: path.join(root, defaultBehaviorDocAdmissionReceipt),
            requireExisting: false
        });
        console.error(
            `[matrix:${behaviorDocAdmissionTierId}] receipt=${relativeToRoot(admission.receiptFile)}`
            + ` digest=${admission.contentDigest}`
        );
        return;
    }
    const behaviorDocAdmission = await establishBehaviorDocAdmission({
        repositoryRoot: root,
        runId
    });
    if (targetTierId === 'validate-matrix')
    {
        executeStaticMatrixPrerequisite(target, { runId, sourceState: buildSourceState, behaviorDocAdmission });
        return;
    }
    if (!options.noDeps && all.some((tier) => tier.id === 'validate-matrix'))
    {
        const binding = executeStaticMatrixPrerequisite(
            tierMap(matrix).get('validate-matrix'),
            { runId, sourceState: buildSourceState, behaviorDocAdmission }
        );
        if (!options.resume)
        {
            currentRunPreexecutedTierBindings.push(binding);
        }
    }
    all = bindBehaviorDocAdmissionVerification(all, behaviorDocAdmission);
    appendCurrentRunBehaviorDocAdmissionBinding({
        bindings: currentRunPreexecutedTierBindings,
        tiers: all,
        admission: behaviorDocAdmission,
        schedulerRunId: runId,
        sourceState: buildSourceState
    });
    const runNamespace = namespaceFor(target, options.shard, runId);
    const lifecycle = await runProductionBuildLifecycle({
        prepareOptions: {
            root,
            runId,
            fresh: !options.resume,
            sourceState: buildSourceState,
            namespace: runNamespace
        },
        async execute({ buildLayout, recordSchedulerResult, setFinalization, throwIfInterrupted })
        {
            const scheduledTiers = prependManagedProductionBuildGc(all, runId, { enabled: !options.resume });
            const profileGlobalBudgetMs = Math.max(...all
                .map((tier) => Number(tier.correctnessBudget?.profileGlobalBudgetMs))
                .filter((value) => Number.isFinite(value) && value > 0), 0);
            throwIfInterrupted();
            prepareNamespaceEnvironmentIfNeeded(all, runNamespace, {
                runId,
                sourceState: buildSourceState,
                buildLayout
            });
            if (options.fresh)
            {
                resetFreshJobSummaries(all.map((tier) => [tier, {}]));
            }
            const result = recordSchedulerResult(
                await runDag({
                    registerManagedProcess: (identity, _tier, authority) =>
                        registerProductionBuildCompiler(buildLayout, identity, authority),
                    ...mysqlServiceSchedulerOptions(buildLayout, scheduledTiers),
                    sourceState: buildSourceState,
                    namespace: runNamespace,
                    tiers: scheduledTiers,
                    root,
                    runsRoot,
                    runId,
                    targetTierId,
                    budgetPolicyDigest: budgetPolicyBinding.identity.budgetPolicyDigest,
                    wallClockBudgetMs: profileGlobalBudgetMs || undefined,
                    mode: options.resume ? 'resume' : 'fresh',
                    resume: options.resume,
                    currentRunPreexecutedTierBindings,
                    supersedesUniverse: matrix.tiers,
                    coverageRegistry: loadCoverageRegistry().entries,
                    maxParallel: Math.min(
                        options.maxParallel ?? systemResources.availableCpuUnits,
                        systemResources.availableCpuUnits
                    ),
                    systemResources,
                    teeOutput: true,
                    beforeTierStart()
                    {
                        verifyBehaviorDocAdmissionState(behaviorDocAdmission, root);
                    },
                    onSourceState(sourceState)
                    {
                        bindScheduledBuildLayoutSource(buildLayout, sourceState);
                    },
                    envForTier(tier)
                    {
                        const namespaceEnv = loadNamespaceEnv(runNamespace);
                        const env = applyNamespaceBuildEnvironment(
                            tier,
                            productionBuildEnvironment(buildLayout, {
                                ...namespaceEnv,
                                CURRENT_TIER: tier.id,
                                MATRIX_JOB: tier.ciJob,
                                FSUSBLOG_TEST_NAMESPACE: runNamespace,
                                FSUSBLOG_TEST_RUN_ID: runId,
                                FSUSBLOG_BEHAVIOR_DOC_ADMISSION_RECEIPT:
                                    behaviorDocAdmission.receiptFile,
                                FSUSBLOG_BEHAVIOR_DOC_ADMISSION_DIGEST:
                                    behaviorDocAdmission.contentDigest,
                                FSUSBLOG_BEHAVIOR_DOC_ADMISSION_RUN_ID:
                                    behaviorDocAdmission.runId
                            })
                        );
                        Object.assign(env, resourceEnvironmentForTier(tier, env));
                        applyUxViewportResumeEnvironment(env, tier, options.resume);
                        if (options.shard)
                        {
                            const [index, total] = options.shard.split('/');
                            env.MATRIX_SHARD = options.shard;
                            env.FSUSBLOG_TEST_SHARD_INDEX = index;
                            env.FSUSBLOG_TEST_SHARD_TOTAL = total;
                            if (tier.requiresPlaywright !== 'none')
                            {
                                env.FSUSBLOG_PLAYWRIGHT_SHARD_ARG = `--shard=${index}/${total}`;
                            }
                        }
                        return applyMatrixFixtureProfileEnvironment(tier, env);
                    },
                    onTierStart(tier)
                    {
                        emitTierReproductionHint(tier, options);
                        console.error(`[matrix:${tier.id}] ${tier.command}`);
                    },
                    onTierReused(tier)
                    {
                        console.error(`[matrix:${tier.id}] reused successful checkpoint from ${runId}`);
                    },
                    onTierComplete(tier, tierResult)
                    {
                        const startedAt = Date.now() - tierResult.durationMs;
                        if (tierResult.status === 'success')
                        {
                            writeJobSummary(matrix, tier, 'success', startedAt, {
                                schedulerRunId: runId,
                                budgetPolicyDigest: tier.correctnessBudget
                                    ? budgetPolicyBinding.receipt.budgetPolicyDigest
                                    : null,
                                timeoutPhase: tierResult.timeoutPhase
                            });
                        }
                        else
                        {
                            writeJobSummary(matrix, tier, 'failure', startedAt, {
                                schedulerRunId: runId,
                                budgetPolicyDigest: tier.correctnessBudget
                                    ? budgetPolicyBinding.receipt.budgetPolicyDigest
                                    : null,
                                timeoutPhase: tierResult.timeoutPhase,
                                failureStage: stageForTier(tier),
                                rootCause: tierResult.reason
                            });
                        }
                    }
                })
            );

            console.error(
                `[matrix:${target.id}] run=${result.runId} checkpoint=${relativeToRoot(result.checkpointPath)}`
            );
            if (options.fresh && new Set(['production', 'release-final']).has(targetTierId))
            {
                cleanupSensitiveFixtures(runNamespace, loadNamespaceEnv(runNamespace));
                console.error(`[matrix:${target.id}] removed namespaced auth fixture cache`);
            }
            setFinalization({
                status:
                    result.status === 'success' ? 'success' : result.failure?.signal ? 'cancelled' : 'failure',
                primaryFailure: result.status === 'success' ? null : result.failure
            });
            return result;
        }
    });
    const result = lifecycle.operationResult;
    if (result.status !== 'success')
    {
        const exitCode = Number(result.failure?.exitCode) || 1;
        console.error(
            `[matrix:${result.failure?.tierId ?? target.id}] ${result.failure?.reason ?? 'scheduler failed'}`
        );
        process.exitCode = exitCode;
    }
}

function parseCiJobOptions(args)
{
    const options = { planOnly: false, shard: null, resume: false, fresh: false, maxParallel: null };
    for (let index = 0; index < args.length; index += 1)
    {
        const arg = args[index];
        if (arg === '--plan-only')
        {
            options.planOnly = true;
        }
        else if (arg === '--shard')
        {
            options.shard = args[++index];
        }
        else if (arg.startsWith('--shard='))
        {
            options.shard = arg.slice('--shard='.length);
        }
        else if (arg === '--resume')
        {
            options.resume = true;
        }
        else if (arg === '--fresh')
        {
            options.fresh = true;
        }
        else if (arg === '--max-parallel')
        {
            options.maxParallel = Number(args[++index]);
        }
        else if (arg.startsWith('--max-parallel='))
        {
            options.maxParallel = Number(arg.slice('--max-parallel='.length));
        }
        else
        {
            throw new Error(`unknown ci-job option: ${arg}`);
        }
    }
    normalizeSchedulerOptions(options);
    return options;
}

function parseCiJobMatrixOptions(args)
{
    const options = { outFile: null, githubOutputFile: null, prPlanFile: null };
    for (let index = 0; index < args.length; index += 1)
    {
        const arg = args[index];
        if (arg === '--out')
        {
            options.outFile = args[++index];
        }
        else if (arg.startsWith('--out='))
        {
            options.outFile = arg.slice('--out='.length);
        }
        else if (arg === '--github-output')
        {
            options.githubOutputFile = args[++index];
        }
        else if (arg.startsWith('--github-output='))
        {
            options.githubOutputFile = arg.slice('--github-output='.length);
        }
        else if (arg === '--pr-plan')
        {
            options.prPlanFile = args[++index];
        }
        else if (arg.startsWith('--pr-plan='))
        {
            options.prPlanFile = arg.slice('--pr-plan='.length);
        }
        else
        {
            throw new Error(`unknown ci-job-matrix option: ${arg}`);
        }
    }
    return options;
}

function ciJobTiers(matrix, jobId)
{
    return matrix.tiers.filter((tier) => tier.ciJob === jobId && tier.localOnly !== true && tier.nightlyOnly !== true && tier.manualOnly !== true);
}

function effectiveCiJobTiers(matrix, jobId)
{
    return applySupersedes(ciJobTiers(matrix, jobId));
}

function ciJobExecutionMode(matrix, jobId)
{
    return Object.values(matrix.aggregateAuthorities ?? {}).some((authority) => authority?.ciJob === jobId)
        ? 'aggregate'
        : 'test';
}

function hasIntersection(left, right)
{
    const rightSet = new Set(right ?? []);
    return (left ?? []).some((item) => rightSet.has(item));
}

function ciJobMaxParallel(tiers)
{
    return Math.max(1, ...tiers.map((tier) => Number(tier.maxParallel) || 1));
}

function internalCiJobDependencies(tier, tierIds)
{
    return tierExecutionDependencies(tier).filter((dependencyId) => tierIds.has(dependencyId));
}

function activeResourceClassCount(active, resourceClass)
{
    return active.filter((entry) => entry.tier.resourceClass === resourceClass).length;
}

function canRunTogether(candidate, activeTier, active)
{
    if (candidate.parallelizable !== true || activeTier.parallelizable !== true)
    {
        return false;
    }
    if (hasIntersection(candidate.exclusiveResources, activeTier.exclusiveResources))
    {
        return false;
    }
    if ((candidate.services?.length ?? 0) > 0 && (activeTier.services?.length ?? 0) > 0 && hasIntersection(candidate.services, activeTier.services))
    {
        return false;
    }
    if (candidate.resourceClass === activeTier.resourceClass)
    {
        const sameClassActive = activeResourceClassCount(active, candidate.resourceClass);
        if (sameClassActive >= Number(candidate.maxParallel || 1))
        {
            return false;
        }
        if (sameClassActive >= Number(activeTier.maxParallel || 1))
        {
            return false;
        }
    }
    return true;
}

function canStartCiJobTier(candidate, activeEntries, jobMaxParallel)
{
    if (activeEntries.length >= jobMaxParallel)
    {
        return false;
    }
    return activeEntries.every((entry) => canRunTogether(candidate, entry.tier, activeEntries));
}

function ciJobHasParallelWave(tiers)
{
    const pending = [...tiers];
    const completed = new Set();
    const tierIds = new Set(tiers.map((tier) => tier.id));
    let sawParallelWave = false;

    while (pending.length > 0)
    {
        const active = [];
        for (const tier of [...pending])
        {
            const dependenciesDone = internalCiJobDependencies(tier, tierIds).every((dependencyId) => completed.has(dependencyId));
            if (dependenciesDone && canStartCiJobTier(tier, active, ciJobMaxParallel(tiers)))
            {
                active.push({ tier });
            }
        }
        if (active.length === 0)
        {
            return sawParallelWave;
        }
        if (active.length > 1)
        {
            sawParallelWave = true;
        }
        for (const { tier } of active)
        {
            const index = pending.findIndex((item) => item.id === tier.id);
            if (index >= 0)
            {
                pending.splice(index, 1);
            }
            completed.add(tier.id);
        }
    }

    return sawParallelWave;
}

function ciJobSchedulerMode(tiers)
{
    return ciJobHasParallelWave(tiers) ? 'parallel' : 'serial';
}

async function loadSelectedTierIds(matrix, prPlanFile, callerContext = prImpactCallerContext())
{
    if (!prPlanFile)
    {
        return null;
    }
    const abs = path.resolve(root, prPlanFile);
    if (!fs.existsSync(abs))
    {
        throw new Error(`PR smart gate plan does not exist: ${relativeToRoot(abs)}`);
    }
    const plan = JSON.parse(fs.readFileSync(abs, 'utf8'));
    const identity = await prSmartGateIdentity();
    const rebuilt = buildPrSmartGatePlan(matrix, { baseRef: callerContext.baseRef, eventName: callerContext.eventName, full: callerContext.full, stage: callerContext.stage }, identity);
    validatePrImpactPlanBinding(plan, { evidence: rebuilt.changedPathEvidence, actualFingerprint: identity.sourceState.worktreeFingerprint,
        selectedTierIds: rebuilt.selectedTierIds, selectedJobs: rebuilt.selectedJobs,
        deferredQualificationTierIds: rebuilt.deferredQualificationTierIds,
        fullQualificationTierIds: rebuilt.fullQualificationTierIds, callerContext });
    validateApplicablePrExecution(matrix, plan);
    return new Set(plan.selectedTierIds);
}

export function buildCiJobMatrix(matrix, jobId, selectedTierIds = null, allowEmpty = false)
{
    const declaredTiers = applySupersedes(ciJobTiers(matrix, jobId)
        .filter((tier) => selectedTierIds === null || selectedTierIds.has(tier.id)));
    const systemResources = logicalTierSystemResources();
    const tiers = resolveLogicalTierResources(declaredTiers, systemResources);
    if (tiers.length === 0)
    {
        if (allowEmpty)
        {
            return { resource_resolution: systemResources, include: [] };
        }
        throw new Error(`unknown CI job or no required tiers: ${jobId}`);
    }

    const include = [];
    for (const tier of tiers)
    {
        const totalShards = tier.shardable ? Number(tier.defaultShards) || 1 : 1;
        if (totalShards > 1)
        {
            for (let index = 1; index <= totalShards; index += 1)
            {
                const shard = `${index}/${totalShards}`;
                const shardLabel = shardId(index, totalShards);
                include.push({
                    tier: tier.id,
                    ci_job: tier.ciJob,
                    shard,
                    shard_id: shardLabel,
                    resource_class: tier.resourceClass,
                    max_parallel: tier.maxParallel,
                    cpu_units: tier.cpuUnits,
                    memory_gib: tier.memoryGiB,
                    cpu_weight: tier.cpuWeight,
                    memory_weight: tier.memoryWeight,
                    min_cpu_units: tier.minCpuUnits,
                    playwright_workers: playwrightWorkersForTier(tier) ?? 1,
                    timeout_minutes: tier.timeoutMinutes,
                    artifact_name: `${jobId}-${shardLabel}`
                });
            }
            continue;
        }

        include.push({
            tier: tier.id,
            ci_job: tier.ciJob,
            shard: '',
            shard_id: tier.id,
            resource_class: tier.resourceClass,
            max_parallel: tier.maxParallel,
            cpu_units: tier.cpuUnits,
            memory_gib: tier.memoryGiB,
            cpu_weight: tier.cpuWeight,
            memory_weight: tier.memoryWeight,
            min_cpu_units: tier.minCpuUnits,
            playwright_workers: playwrightWorkersForTier(tier) ?? 1,
            timeout_minutes: tier.timeoutMinutes,
            artifact_name: `${jobId}-${tier.id}`
        });
    }

    return {
        resource_resolution: {
            ...systemResources,
            defaultShards: dynamicShardCount(systemResources)
        },
        include
    };
}

async function ciJobMatrix(matrix, jobId, args)
{
    const options = parseCiJobMatrixOptions(args);
    const payload = buildCiJobMatrix(matrix, jobId, await loadSelectedTierIds(matrix, options.prPlanFile));
    const maxParallel = Math.max(...payload.include.map((entry) => Number(entry.max_parallel || 1)));

    if (options.githubOutputFile)
    {
        const abs = path.resolve(root, options.githubOutputFile);
        ensureOutputDirectory(abs);
        fs.appendFileSync(abs, `matrix=${JSON.stringify(payload)}\n`);
        fs.appendFileSync(abs, `max_parallel=${maxParallel}\n`);
        console.log(`[matrix:ci-job-matrix] wrote ${relativeToRoot(abs)} for ${jobId}`);
        return;
    }

    const text = `${JSON.stringify({
        job: jobId,
        max_parallel: maxParallel,
        matrix: payload
    }, null, 2)}\n`;
    writeTextOutput(text, options.outFile, 'matrix:ci-job-matrix');
}

function printCiJobPlan(matrix, jobId)
{
    const declaredTiers = ciJobTiers(matrix, jobId);
    const tiers = resolveLogicalTierResources(applySupersedes(declaredTiers));
    if (tiers.length === 0)
    {
        throw new Error(`unknown CI job or no required tiers: ${jobId}`);
    }
    console.log(`To reproduce GitHub Actions job "${jobId}" locally:`);
    console.log(`  ${ciJobReproductionCommand(jobId, matrix)}`);
    console.log(`  execution mode: ${ciJobExecutionMode(matrix, jobId)}`);
    console.log(`  scheduler: ${ciJobSchedulerMode(tiers)} (max ${ciJobMaxParallel(tiers)}, debug fallback: FSUSBLOG_CI_JOB_SERIAL=1)`);
    const effectiveIds = new Set(tiers.map((tier) => tier.id));
    for (const tier of declaredTiers.filter((tier) => !effectiveIds.has(tier.id)))
    {
        const replacement = declaredTiers.find((candidate) => (candidate.supersedes ?? []).includes(tier.id));
        console.log(`  superseded: ${tier.id} -> ${replacement?.id ?? 'replacement tier'}`);
    }
    console.log('');
    for (const tier of tiers)
    {
        const shard = tier.shardable ? ` --shard 1/${tier.defaultShards}` : '';
        console.log(`- ${tier.id}: ${tierReproductionCommand(tier, { noDeps: true })}${shard}`);
        console.log(`  matrix command: ${tier.command}`);
    }
}

async function runCiJobScheduled(matrix, jobId, tiers, options, existingBehaviorDocAdmission = null)
{
    const targetTierId = `ci-job/${jobId}`;
    const { runsRoot, runId } = schedulerRunIdentity(targetTierId, options);
    const { sourceState: buildSourceState } = await collectSchedulerSourceState(root);
    const behaviorDocAdmission = existingBehaviorDocAdmission ?? await establishBehaviorDocAdmission({
        repositoryRoot: root,
        runId
    });
    if (behaviorDocAdmission)
    {
        tiers = bindBehaviorDocAdmissionVerification(tiers, behaviorDocAdmission);
    }
    const currentRunPreexecutedTierBindings = [];
    if (behaviorDocAdmission)
    {
        appendCurrentRunBehaviorDocAdmissionBinding({
            bindings: currentRunPreexecutedTierBindings,
            tiers,
            admission: behaviorDocAdmission,
            schedulerRunId: runId,
            sourceState: buildSourceState
        });
    }
    const buildNamespace = namespaceFor({ id: targetTierId, ciJob: jobId }, options.shard, runId);
    const schedulerMode = options.forceSerial ? 'serial' : 'parallel';
    const dynamicMaximum = Math.min(ciJobMaxParallel(tiers), options.systemResources.availableCpuUnits);
    const maxParallel = options.forceSerial
        ? 1
        : Math.min(options.maxParallel ?? dynamicMaximum, dynamicMaximum);
    const lifecycle = await runProductionBuildLifecycle({
        prepareOptions: {
            root,
            runId,
            fresh: !options.resume,
            sourceState: buildSourceState,
            namespace: buildNamespace
        },
        async execute({ buildLayout, recordSchedulerResult, setFinalization, throwIfInterrupted })
        {
            throwIfInterrupted();
            console.error(`[matrix:ci-job:${jobId}] scheduler=${schedulerMode} max=${maxParallel}`);
            const bootstrapTier = tiers.find((tier) => tier.selfBootstraps === true);
            if (bootstrapTier)
            {
                prepareNamespaceEnvironmentIfNeeded(
                    tiers,
                    namespaceFor(bootstrapTier, options.shard, runId),
                    {
                        runId,
                        sourceState: buildSourceState,
                        buildLayout
                    }
                );
            }
            if (options.fresh)
            {
                resetFreshJobSummaries(
                    tiers.map((tier) => [
                        tier,
                        {
                            jobId: options.forceSerial ? jobId : `${jobId}-${tier.id}`
                        }
                    ])
                );
            }

            const result = recordSchedulerResult(
                await runDag({
                    registerManagedProcess: (identity, _tier, authority) =>
                        registerProductionBuildCompiler(buildLayout, identity, authority),
                    ...mysqlServiceSchedulerOptions(buildLayout, tiers),
                    sourceState: buildSourceState,
                    namespace: buildNamespace,
                    tiers,
                    root,
                    runsRoot,
                    runId,
                    targetTierId,
                    mode: options.resume ? 'resume' : 'fresh',
                    resume: options.resume,
                    currentRunPreexecutedTierBindings,
                    supersedesUniverse: matrix.tiers,
                    coverageRegistry: loadCoverageRegistry().entries,
                    maxParallel,
                    systemResources: options.systemResources,
                    teeOutput: true,
                    beforeTierStart()
                    {
                        if (behaviorDocAdmission)
                        {
                            verifyBehaviorDocAdmissionState(behaviorDocAdmission, root);
                        }
                    },
                    onSourceState(sourceState)
                    {
                        bindScheduledBuildLayoutSource(buildLayout, sourceState);
                    },
                    envForTier(tier)
                    {
                        const runNamespace = tier.services?.includes('mysql')
                            ? buildNamespace : namespaceFor(tier, options.shard, runId);
                        const env = applyNamespaceBuildEnvironment(
                            tier,
                            productionBuildEnvironment(buildLayout, {
                                ...loadNamespaceEnv(runNamespace),
                                CURRENT_TIER: tier.id,
                                MATRIX_JOB: tier.ciJob,
                                FSUSBLOG_TEST_NAMESPACE: runNamespace,
                                FSUSBLOG_TEST_RUN_ID: runId,
                                FSUSBLOG_CI_JOB_ID: options.forceSerial ? jobId : `${jobId}-${tier.id}`,
                                FSUSBLOG_CI_JOB_SCHEDULER: schedulerMode,
                                ...(behaviorDocAdmission ? {
                                    FSUSBLOG_BEHAVIOR_DOC_ADMISSION_RECEIPT:
                                        behaviorDocAdmission.receiptFile,
                                    FSUSBLOG_BEHAVIOR_DOC_ADMISSION_DIGEST:
                                        behaviorDocAdmission.contentDigest,
                                    FSUSBLOG_BEHAVIOR_DOC_ADMISSION_RUN_ID:
                                        behaviorDocAdmission.runId
                                } : {})
                            })
                        );
                        Object.assign(env, resourceEnvironmentForTier(tier, env));
                        applyUxViewportResumeEnvironment(env, tier, options.resume);
                        if (options.shard && tier.shardable)
                        {
                            const [index, total] = options.shard.split('/');
                            env.MATRIX_SHARD = options.shard;
                            env.FSUSBLOG_TEST_SHARD_INDEX = index;
                            env.FSUSBLOG_TEST_SHARD_TOTAL = total;
                            if (tier.requiresPlaywright !== 'none')
                            {
                                env.FSUSBLOG_PLAYWRIGHT_SHARD_ARG = `--shard=${index}/${total}`;
                            }
                        }
                        return applyMatrixFixtureProfileEnvironment(tier, env);
                    },
                    onTierStart(tier)
                    {
                        emitTierReproductionHint(tier, { noDeps: true, shard: options.shard });
                        console.error(`[matrix:ci-job:${jobId}] started ${tier.id}: ${tier.command}`);
                    },
                    onTierReused(tier)
                    {
                        console.error(`[matrix:ci-job:${jobId}] reused ${tier.id} from ${runId}`);
                    },
                    onTierComplete(tier, tierResult)
                    {
                        const startedAt = Date.now() - tierResult.durationMs;
                        const success = tierResult.status === 'success';
                        writeJobSummary(matrix, tier, success ? 'success' : 'failure', startedAt, {
                            jobId: options.forceSerial ? jobId : `${jobId}-${tier.id}`,
                            schedulerRunId: runId,
                            failureStage: success ? null : stageForTier(tier),
                            rootCause: success ? null : tierResult.reason
                        });
                        console.error(`[matrix:ci-job:${jobId}] ${tier.id} ${tierResult.status}`);
                    }
                })
            );
            console.error(
                `[matrix:ci-job:${jobId}] run=${result.runId} checkpoint=${relativeToRoot(result.checkpointPath)}`
            );
            setFinalization({
                status:
                    result.status === 'success' ? 'success' : result.failure?.signal ? 'cancelled' : 'failure',
                primaryFailure: result.status === 'success' ? null : result.failure
            });
            return result;
        }
    });
    const result = lifecycle.operationResult;
    return result.status === 'success' ? 0 : Number(result.failure?.exitCode) || 1;
}

async function runCiJob(matrix, jobId, args, context = {})
{
    if (sourceCoordinationTierIds.has(jobId))
    {
        await runSourceCoordinationTier(matrix, jobId, args);
        return 0;
    }
    const options = parseCiJobOptions(args);
    const declaredTiers = effectiveCiJobTiers(matrix, jobId);
    if (declaredTiers.length === 0)
    {
        throw new Error(`unknown CI job or no required tiers: ${jobId}`);
    }
    if (options.shard && !/^\d+\/\d+$/.test(options.shard))
    {
        throw new Error('--shard must use i/n format');
    }
    if (options.planOnly)
    {
        printCiJobPlan(matrix, jobId);
        return;
    }
    if (jobId === 'validate-matrix')
    {
        if (!context.preflightComplete)
        {
            const { runId } = schedulerRunIdentity(`ci-job/${jobId}`, options);
            const { sourceState } = await collectSchedulerSourceState(root);
            context.behaviorDocAdmission ??= await establishBehaviorDocAdmission({ repositoryRoot: root, runId });
            executeStaticMatrixPrerequisite(declaredTiers[0], { runId, sourceState, behaviorDocAdmission: context.behaviorDocAdmission });
        }
        const remainingTiers = declaredTiers.filter((tier) => tier.id !== 'validate-matrix');
        if (remainingTiers.length === 0)
        {
            return 0;
        }
        options.systemResources = logicalTierSystemResources();
        const resolvedTiers = resolveLogicalTierResources(remainingTiers, options.systemResources);
        options.forceSerial = process.env.FSUSBLOG_CI_JOB_SERIAL === '1'
            || ciJobSchedulerMode(resolvedTiers) === 'serial';
        const status = await runCiJobScheduled(
            matrix,
            jobId,
            resolvedTiers,
            options,
            context.behaviorDocAdmission
        );
        if (status !== 0)
        {
            process.exitCode = status;
        }
        return status;
    }
    if (jobId === behaviorDocAdmissionTierId)
    {
        await runTier(matrix, behaviorDocAdmissionTierId, args);
        return Number(process.exitCode) || 0;
    }

    options.systemResources = logicalTierSystemResources();
    const tiers = resolveLogicalTierResources(declaredTiers, options.systemResources);
    options.forceSerial = process.env.FSUSBLOG_CI_JOB_SERIAL === '1' || ciJobSchedulerMode(tiers) === 'serial';
    if (process.env.FSUSBLOG_CI_JOB_SERIAL === '1')
    {
        console.error(`[matrix:ci-job:${jobId}] scheduler=serial forced by FSUSBLOG_CI_JOB_SERIAL=1`);
    }
    const status = await runCiJobScheduled(
        matrix,
        jobId,
        tiers,
        options,
        context.behaviorDocAdmission
    );
    if (status !== 0)
    {
        process.exitCode = status;
    }
    return status;
}

function parseAggregateOptions(args)
{
    const options = { dryRun: false, outFile: null, githubNeedsJson: process.env.QUALITY_GATE_NEEDS_JSON ?? null };
    for (let index = 0; index < args.length; index += 1)
    {
        const arg = args[index];
        if (arg === '--dry-run')
        {
            options.dryRun = true;
        }
        else if (arg === '--out')
        {
            options.outFile = args[++index];
        }
        else if (arg.startsWith('--out='))
        {
            options.outFile = arg.slice('--out='.length);
        }
        else if (arg === '--github-needs')
        {
            options.githubNeedsJson = args[++index];
        }
        else if (arg.startsWith('--github-needs='))
        {
            options.githubNeedsJson = arg.slice('--github-needs='.length);
        }
        else
        {
            throw new Error(`unknown aggregate option: ${arg}`);
        }
    }
    return options;
}

function generatedMatrixSummaryIds(matrix, jobId)
{
    const tiers = resolveLogicalTierResources(effectiveCiJobTiers(matrix, jobId));
    const shardSummaryIds = [];
    const unshardedTierSummaryIds = [];
    for (const tier of tiers)
    {
        const totalShards = tier.shardable ? Number(tier.defaultShards) || 1 : 1;
        if (totalShards <= 1)
        {
            unshardedTierSummaryIds.push(`${jobId}-${tier.id}`);
            continue;
        }
        for (let index = 1; index <= totalShards; index += 1)
        {
            shardSummaryIds.push(`${jobId}-${shardId(index, totalShards)}`);
        }
    }
    if (new Set(['fast-backend', 'fast-frontend-unit']).has(jobId))
    {
        return ciJobSchedulerMode(tiers) === 'parallel'
            ? [...shardSummaryIds, ...unshardedTierSummaryIds]
            : [jobId];
    }
    if (shardSummaryIds.length > 0)
    {
        return shardSummaryIds;
    }
    return [jobId];
}

function aggregateRequiredPaths(matrix, dependencyJobs, summaryTiers)
{
    const paths = new Set();
    const addTierPaths = (tier) =>
    {
        for (const artifact of tier.artifacts ?? [])
        {
            paths.add(artifact);
        }
        for (const evidence of tier.evidence ?? [])
        {
            paths.add(evidence);
        }
    };
    for (const tier of summaryTiers)
    {
        addTierPaths(tier);
    }
    for (const jobId of dependencyJobs)
    {
        for (const tier of effectiveCiJobTiers(matrix, jobId))
        {
            addTierPaths(tier);
        }
    }
    return [...paths].filter(requiresAggregateArtifact).sort();
}

function requiresAggregateArtifact(value)
{
    const normalized = String(value ?? '').trim().replace(/^['"]|['"]$/g, '');
    return normalized.startsWith('.tmp/')
    || normalized.startsWith('src/frontend/coverage')
    || normalized.startsWith('src/frontend/test-results/')
    || normalized.startsWith('src/frontend/playwright-report')
    || normalized.startsWith('BenchmarkDotNet.Artifacts/');
}

function buildAggregatePlan(matrix, jobId)
{
    const reachability = buildAggregateReachabilityPlan(matrix, jobId);
    if (reachability.errors.length > 0)
    {
        throw new Error(reachability.errors[0]);
    }
    const byId = tierMap(matrix);
    const summaryTiers = reachability.selectedTierIds.map((tierId) => byId.get(tierId)).filter(Boolean);
    const dependencyJobs = reachability.dependencyJobs;
    const receiptJobs = [...new Set(reachability.dependencyReceipts.map((receipt) => receipt.jobId))].sort();
    const requiredArtifactPaths = new Set(aggregateRequiredPaths(matrix, dependencyJobs, summaryTiers));
    for (const receiptInput of reachability.requiredReceiptInputs)
    {
        if (requiresAggregateArtifact(receiptInput))
        {
            requiredArtifactPaths.add(receiptInput);
        }
    }
    return {
        ...reachability,
        dependencyJobs,
        requiredJobSummaries: receiptJobs.flatMap((receiptJob) => generatedMatrixSummaryIds(matrix, receiptJob)).sort(),
        requiredArtifactPaths: [...requiredArtifactPaths].sort(),
        localReproduction: `node tools/run-test-matrix.mjs aggregate ${jobId}`
    };
}

function findFiles(dir, predicate, results = [])
{
    if (!fs.existsSync(dir))
    {
        return results;
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }))
    {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory())
        {
            findFiles(file, predicate, results);
        }
        else if (predicate(file))
        {
            results.push(file);
        }
    }
    return results;
}

function loadJobSummaries()
{
    const summaries = new Map();
    const transport = String(process.env.FSUSBLOG_EVIDENCE_TRANSPORT_MANIFEST ?? '').trim();
    const roots = transport
        ? []
        : [path.join(root, '.tmp/release-evidence/jobs')];
    const files = transport
        ? (JSON.parse(fs.readFileSync(path.resolve(root, transport), 'utf8')).objects ?? [])
            .filter((object) => object.authorityId === 'evidence-consumer.ci.check-job-summaries.current-run'
                || object.authorityId === 'evidence-consumer.workflow.quality-gate.current-run')
            .flatMap((object) => object.archiveEntries ?? [])
            .map((entry) => path.resolve(root, entry.extractedPath))
        : roots.flatMap((searchRoot) => findFiles(searchRoot, (candidate) => candidate.endsWith('.json') && candidate.includes(`${path.sep}jobs${path.sep}`)));
    for (const file of files)
    {
        try
        {
            const summary = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (summary.schema !== 'fsusblog.ci.job-result.v1')
            {
                continue;
            }
            summaries.set(summary.jobId, { summary, file });
            if (summary.ciJob && !summaries.has(summary.ciJob))
            {
                summaries.set(summary.ciJob, { summary, file });
            }
        }
        catch
        {
            // Ignore unrelated JSON artifacts.
        }
    }
    return summaries;
}

function aggregatePathExists(rel)
{
    const transport = String(process.env.FSUSBLOG_EVIDENCE_TRANSPORT_MANIFEST ?? '').trim();
    if (transport)
    {
        const manifest = JSON.parse(fs.readFileSync(path.resolve(root, transport), 'utf8'));
        const extracted = (manifest.objects ?? []).flatMap((object) => object.archiveEntries ?? [])
            .map((entry) => String(entry.extractedPath ?? '').replaceAll('\\', '/'));
        const normalized = String(rel ?? '').replaceAll('\\', '/');
        return extracted.includes(normalized)
            || extracted.some((entry) => entry.endsWith(`/${path.posix.basename(normalized)}`));
    }
    return aggregateArtifactPathExists({
        root,
        downloadedRoot: path.join(root, '.tmp/absent-transport-root'),
        declaration: rel
    });
}

function githubNeedsErrors(rawNeedsJson, dependencyJobs)
{
    if (!rawNeedsJson)
    {
        return [];
    }
    let needs;
    try
    {
        needs = JSON.parse(rawNeedsJson);
    }
    catch (error)
    {
        return [`QUALITY_GATE_NEEDS_JSON is not valid JSON: ${error.message}`];
    }

    const errors = [];
    for (const jobId of dependencyJobs)
    {
        const result = needs?.[jobId]?.result;
        if (result && result !== 'success')
        {
            errors.push(`${jobId} completed with result=${result}`);
        }
    }
    return errors;
}

function aggregateCiJob(matrix, jobId, args)
{
    const options = parseAggregateOptions(args);
    const plan = buildAggregatePlan(matrix, jobId);

    if (options.dryRun)
    {
        writeTextOutput(`${JSON.stringify(plan, null, 2)}\n`, options.outFile, 'matrix:aggregate');
        return;
    }

    const startedAt = Date.now();
    const summaryTier = tierMap(matrix).get(plan.selectedTierIds[0]);
    const errors = githubNeedsErrors(options.githubNeedsJson, plan.dependencyJobs);
    const summaries = loadJobSummaries();

    console.log(`[matrix:aggregate] ${jobId} is artifact-only; no test commands will be executed`);
    console.log(`[matrix:aggregate] dependency jobs: ${plan.dependencyJobs.join(', ')}`);
    console.log(`[matrix:aggregate] required job summaries: ${plan.requiredJobSummaries.join(', ')}`);

    for (const summaryId of plan.requiredJobSummaries)
    {
        const match = summaries.get(summaryId);
        if (!match)
        {
            errors.push(`missing job summary artifact: ${summaryId}`);
            continue;
        }
        if (match.summary.status !== 'success')
        {
            errors.push(`${summaryId} status=${match.summary.status}`);
        }
    }

    for (const requiredPath of plan.requiredArtifactPaths)
    {
        if (!aggregatePathExists(requiredPath))
        {
            errors.push(`missing aggregate artifact path: ${requiredPath}`);
        }
    }

    if (errors.length > 0)
    {
        writeJobSummary(matrix, summaryTier, 'failure', startedAt, {
            stage: 'summary',
            failureStage: 'summary',
            rootCause: errors[0],
            localReproduction: plan.localReproduction
        });
        for (const error of errors)
        {
            console.error(`[matrix:aggregate] ${error}`);
        }
        process.exit(1);
    }

    writeJobSummary(matrix, summaryTier, 'success', startedAt, {
        stage: 'summary',
        localReproduction: plan.localReproduction
    });
    console.log(`[matrix:aggregate] ok (${plan.requiredJobSummaries.length} job summaries, ${plan.requiredArtifactPaths.length} artifact paths)`);
}

function listTiers(matrix)
{
    for (const tier of matrix.tiers)
    {
        const tags = [
            `job=${tier.ciJob}`,
            `risk=${tier.risk}`,
            `cadence=${tier.cadence}`,
            `requiredFor=${tier.requiredFor}`,
            `evidenceClass=${tier.evidenceClass ?? 'correctness'}`,
      tier.parallelizable ? 'parallel:machine' : 'serial',
      tier.shardable ? 'shardable:machine' : 'single'
        ];
        console.log(`${tier.id}\t${tags.join(' ')}`);
    }
}

function ensureOutputDirectory(filePath)
{
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeTextOutput(text, outFile, label)
{
    if (!outFile)
    {
        process.stdout.write(text);
        return;
    }

    const abs = path.resolve(root, outFile);
    ensureOutputDirectory(abs);
    fs.writeFileSync(abs, text);
    console.log(`[${label}] wrote ${relativeToRoot(abs)}`);
}

export function buildCiPlan(matrix, format,
    planningMetadata = projectLogicalTierPlanningMetadata(matrix.tiers))
{
    const combineCacheProfile = (left, right) =>
    {
        const frontend = left === 'frontend' || left === 'full' || right === 'frontend' || right === 'full';
        const backend = left === 'backend' || left === 'full' || right === 'backend' || right === 'full';
        return frontend && backend ? 'full' : frontend ? 'frontend' : backend ? 'backend' : 'none';
    };
    const jobs = new Map();
    for (const tier of matrix.tiers)
    {
        const metadata = planningMetadata.get(tier.id);
        const job = jobs.get(tier.ciJob) ?? {
            id: tier.ciJob,
            tiers: [],
            timeoutMinutes: 0,
            needs: new Set(),
            artifacts: new Set(),
            evidence: new Set(),
            evidenceClasses: new Set(),
            requiresNode: false,
            requiresDotnet: false,
            requiresPlaywright: 'none',
            playwrightWorkerValues: new Set(),
            cacheProfile: 'none'
        };
        job.tiers.push(tier.id);
        job.timeoutMinutes = Math.max(job.timeoutMinutes, tier.timeoutMinutes);
        job.phase = Math.max(job.phase ?? 0, tier.phase);
        job.maxParallel = Math.max(job.maxParallel ?? 1, metadata.maxParallel);
        job.requiresNode = job.requiresNode || tier.requiresNode;
        job.requiresDotnet = job.requiresDotnet || tier.requiresDotnet;
        if (tier.requiresPlaywright === 'all')
        {
            job.requiresPlaywright = 'all';
        }
        else if (tier.requiresPlaywright === 'chromium' && job.requiresPlaywright === 'none')
        {
            job.requiresPlaywright = 'chromium';
        }
        const playwrightWorkers = metadata.playwrightWorkers;
        if (playwrightWorkers !== null)
        {
            job.playwrightWorkerValues.add(playwrightWorkers);
        }
        job.cacheProfile = combineCacheProfile(job.cacheProfile, tier.cacheProfile);
        for (const artifact of tier.artifacts)
        {
            job.artifacts.add(artifact);
        }
        for (const evidence of tier.evidence)
        {
            job.evidence.add(evidence);
        }
        job.evidenceClasses.add(tier.evidenceClass ?? (tier.ciJob === 'browser-diagnostics' ? 'diagnostic' : 'correctness'));
        jobs.set(tier.ciJob, job);
    }
    const byId = tierMap(matrix);
    for (const tier of matrix.tiers)
    {
        const job = jobs.get(tier.ciJob);
        for (const dep of tierExecutionDependencies(tier))
        {
            const depJob = byId.get(dep)?.ciJob;
            if (depJob && depJob !== tier.ciJob)
            {
                job.needs.add(depJob);
            }
        }
    }
    return {
        format,
        generatedAt: new Date().toISOString(),
        jobs: [...jobs.values()].map((job) => ({
            id: job.id,
            tiers: job.tiers,
            timeoutMinutes: job.timeoutMinutes,
            phase: job.phase ?? 0,
            maxParallel: job.maxParallel ?? 1,
            requiresNode: job.requiresNode,
            requiresDotnet: job.requiresDotnet,
            requiresPlaywright: job.requiresPlaywright,
            evidenceClasses: [...job.evidenceClasses].sort(),
            playwrightWorkers: [...job.playwrightWorkerValues].sort((left, right) => left - right),
            cacheProfile: job.cacheProfile,
            needs: [...job.needs].sort(),
            artifacts: [...job.artifacts].sort(),
            evidence: [...job.evidence].sort()
        })).sort((a, b) => a.id.localeCompare(b.id))
    };
}

async function runLocalAggregateWorkflow(matrix, aggregateJobId, args)
{
    requireGlobalSourceDeclarations(matrix);
    return runLocalWorkflow({
        matrix,
        aggregateJobId,
        args,
        behaviorDocAdmissionTierId,
        dependencies: {
            aggregateCiJob,
            buildAggregatePlan,
            buildCiPlan,
            ciJobReproductionCommand,
            collectSchedulerSourceState: () => collectSchedulerSourceState(root),
            createRunId,
            effectiveCiJobTiers,
            establishBehaviorDocAdmission: (options) => establishBehaviorDocAdmission({
                repositoryRoot: root,
                ...options
            }),
            executeStaticMatrixPrerequisite,
            parseCiJobOptions,
            relativeToRoot,
            runCiJob,
            tierMap,
            tierReproductionCommand
        }
    });
}

function parsePrSmartGateOptions(args)
{
    const options = {
        outFile: null,
        githubOutputFile: null,
        changedFilesFile: null,
        baseRef: process.env.FSUSBLOG_BASE_REF ?? process.env.GITHUB_BASE_REF ?? 'origin/master',
        eventName: process.env.GITHUB_EVENT_NAME ?? 'local',
        stage: process.env.FSUSBLOG_CI_STAGE ?? 'qualification',
        full: process.env.FSUSBLOG_SMART_GATE_FULL === '1'
    };
    for (let index = 0; index < args.length; index += 1)
    {
        const arg = args[index];
        if (arg === '--out')
        {
            options.outFile = args[++index];
        }
        else if (arg.startsWith('--out='))
        {
            options.outFile = arg.slice('--out='.length);
        }
        else if (arg === '--github-output')
        {
            options.githubOutputFile = args[++index];
        }
        else if (arg.startsWith('--github-output='))
        {
            options.githubOutputFile = arg.slice('--github-output='.length);
        }
        else if (arg === '--changed-files')
        {
            options.changedFilesFile = args[++index];
        }
        else if (arg.startsWith('--changed-files='))
        {
            options.changedFilesFile = arg.slice('--changed-files='.length);
        }
        else if (arg === '--base-ref')
        {
            options.baseRef = args[++index];
        }
        else if (arg.startsWith('--base-ref='))
        {
            options.baseRef = arg.slice('--base-ref='.length);
        }
        else if (arg === '--event-name')
        {
            options.eventName = args[++index];
        }
        else if (arg.startsWith('--event-name='))
        {
            options.eventName = arg.slice('--event-name='.length);
        }
        else if (arg === '--stage' || arg.startsWith('--stage='))
        {
            const stage = arg === '--stage' ? args[++index] : arg.slice('--stage='.length);
            if (!['qualification', 'source-integration'].includes(stage))
            {
                throw new Error('--stage requires qualification or source-integration');
            }
            if (process.env.FSUSBLOG_CI_STAGE && process.env.FSUSBLOG_CI_STAGE !== stage)
            {
                throw new Error('explicit PR stage disagrees with the independent caller environment');
            }
            options.stage = stage;
        }
        else if (arg === '--full')
        {
            options.full = true;
        }
        else if (arg === '--plan-only')
        {
            options.planOnly = true;
        }
        else
        {
            throw new Error(`unknown PR smart gate option: ${arg}`);
        }
    }
    effectivePrExecutionStage(options);
    return options;
}

function summaryAuthorityJobIds()
{
    const workflowFile = path.join(root, '.github/workflows/quality-gate.yml');
    const workflowNeeds = parseWorkflowJobNeeds(fs.readFileSync(workflowFile, 'utf8'), {
        source: '.github/workflows/quality-gate.yml'
    });
    const result = [...(workflowNeeds.get('production-summary') ?? [])].sort();
    if (result.length === 0)
    {
        throw new Error('production-summary workflow direct needs are missing');
    }
    return result;
}

function readChangedFiles(options)
{
    const evidence = readGitChangedPaths(root, options.baseRef || 'origin/master');
    options.changedPathEvidence = evidence;
    if (options.changedFilesFile)
    {
        const abs = path.resolve(root, options.changedFilesFile);
        if (!fs.existsSync(abs))
        {
            throw new Error(`changed files input does not exist: ${relativeToRoot(abs)}`);
        }
        const supplied = fs.readFileSync(abs, 'utf8')
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .sort();
        if (JSON.stringify(supplied) !== JSON.stringify(evidence.changedFiles))
        {
            throw new Error('changed files input does not match the actual merge-base Git diff');
        }
        return evidence.changedFiles;
    }

    return evidence.changedFiles;
}

function wildcardToRegExp(pattern)
{
    const escaped = String(pattern)
        .replaceAll(path.sep, '/')
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .split('**')
        .map((part) => part.replace(/\*/g, '[^/]*'))
        .join('.*');
    return new RegExp(`^${escaped}$`, 'u');
}

function matchesPathPattern(file, pattern)
{
    const normalizedFile = String(file).replaceAll(path.sep, '/');
    const normalizedPattern = String(pattern).replaceAll(path.sep, '/');
    if (normalizedPattern.includes('*'))
    {
        return wildcardToRegExp(normalizedPattern).test(normalizedFile);
    }
    if (normalizedPattern.endsWith('/'))
    {
        return normalizedFile.startsWith(normalizedPattern);
    }
    return normalizedFile === normalizedPattern || normalizedFile.startsWith(`${normalizedPattern}/`);
}

function tierSmartGateMode(tier)
{
    if (tier.smartGateMode)
    {
        return tier.smartGateMode;
    }
    if (tier.prDefault === true || tier.requiredFor === 'fast')
    {
        return 'always';
    }
    if (
        tier.localOnly === true
    || tier.nightlyOnly === true
    || tier.manualOnly === true
    || tier.cadence === 'nightly'
    || tier.cadence === 'release-manual'
    || tier.requiredFor === 'production'
    || tier.requiredFor === 'release-final'
    )
    {
        return 'full-only';
    }
    return 'conditional';
}

export function tierTriggerMatches(tier, changedFiles)
{
    const changed = changedFiles ?? [];
    const triggerFiles = tier.triggerFiles ?? [];
    const triggerPaths = tier.triggerPaths ?? [];
    if (triggerFiles.length > 0 && changed.some((file) => triggerFiles.includes(file)))
    {
        return true;
    }
    if (triggerPaths.length > 0 && changed.some((file) => triggerPaths.some((pattern) => matchesPathPattern(file, pattern))))
    {
        return true;
    }
    if ((tier.triggerCoverage?.length ?? 0) > 0 && changed.some((file) => matchesPathPattern(file, 'tests/coverage-registry.json') || matchesPathPattern(file, 'tests/matrix.yml')))
    {
        return true;
    }
    return false;
}

function isFullSmartGateMode(options)
{
    return options.full === true
    || options.eventName === 'push'
    || options.eventName === 'workflow_dispatch'
    || process.env.FSUSBLOG_RELEASE_FINAL === '1';
}

function retentionReport(matrix)
{
    const byClass = new Map();
    for (const tier of matrix.tiers)
    {
        const retentionClass = tier.retentionClass ?? (
      tier.requiredFor === 'release-final' || tier.risk === 'critical' ? 'must-keep' : 'conditional'
        );
        const bucket = byClass.get(retentionClass) ?? [];
        bucket.push(tier.id);
        byClass.set(retentionClass, bucket);
    }
    return {
        schema: 'fsusblog.test-retention-report.v1',
        classes: Object.fromEntries([...byClass.entries()].sort(([left], [right]) => left.localeCompare(right))),
        redundantCandidateCount: byClass.get('redundant-candidate')?.length ?? 0,
        obsoleteCount: byClass.get('obsolete')?.length ?? 0
    };
}

function buildPrSmartGatePlan(matrix, options, identity)
{
    const changedFiles = readChangedFiles(options);
    if (identity.sourceState.commit !== options.changedPathEvidence.headCommit)
    {
        throw new Error('PR plan source commit does not match the actual Git candidate');
    }
    const impact = selectAffectedPrTiers(matrix, changedFiles, {
        full: isFullSmartGateMode(options),
        stage: effectivePrExecutionStage({ ...options, full: isFullSmartGateMode(options) }),
        executionAuthority: JSON.parse(fs.readFileSync(path.join(root,
            'tests/fixtures/test-matrix/release-final-execution-target-authority.json'), 'utf8')),
        jobDependencies: parseWorkflowJobNeeds(fs.readFileSync(path.join(root, '.github/workflows/quality-gate.yml'), 'utf8'),
            { source: '.github/workflows/quality-gate.yml' })
    });
    const fullMode = impact.fullMode;
    const applicableIds = new Set(impact.selectedTierIds);
    const selectedTiers = [];
    const skippedTiers = [];

    for (const tier of matrix.tiers)
    {
        const mode = tierSmartGateMode(tier);
        const selected = applicableIds.has(tier.id);
        const reason = impact.reasons[tier.id] ?? 'no affected source input; qualification remains unrun';

        const entry = {
            id: tier.id,
            ciJob: tier.ciJob,
            smartGateMode: mode,
            prDefault: tier.prDefault === true,
            retentionClass: tier.retentionClass ?? null,
            evidenceClass: tier.evidenceClass ?? 'correctness',
            triggerReason: tier.triggerReason ?? null,
            reason
        };
        if (selected)
        {
            selectedTiers.push(entry);
        }
        else
        {
            skippedTiers.push(entry);
        }
    }

    // Most workflow jobs execute their complete ciJob tier set once any member
    // is selected. Expand those fixed jobs here so the plan cannot label a tier
    // skipped while the job's hard-coded steps execute it. These exceptions have
    // genuine partial execution: dynamic collector matrices and explicit
    // aggregate command lists.
    const partialExecutionJobs = new Set([
        'backend-qps-collectors',
        'release-evidence',
        'production-summary',
        'browser-diagnostics'
    ]);
    const selectedFixedJobs = new Set(selectedTiers.map((tier) => tier.ciJob)
        .filter((jobId) => !partialExecutionJobs.has(jobId)));
    for (let index = skippedTiers.length - 1; index >= 0; index -= 1)
    {
        const tier = skippedTiers[index];
        const declaration = matrix.tiers.find((candidate) => candidate.id === tier.id);
        if (!selectedFixedJobs.has(tier.ciJob)
      || declaration?.localOnly === true
      || declaration?.nightlyOnly === true
      || declaration?.manualOnly === true)
        {
            continue;
        }
        skippedTiers.splice(index, 1);
        selectedTiers.push({
            ...tier,
            reason: `selected fixed workflow job ${tier.ciJob} executes its complete tier set`
        });
    }

    const immutableBuildConsumerJobs = new Set([
        'integration-runtime',
        'endpoint-depth-runtime',
        'release-public',
        'security-runtime',
        'browser-contract',
        'resilience-runtime',
        'load-smoke',
        'backend-qps-collectors',
        'perf-regression',
        // A passing production-summary always seals a #1078-bound correctness
        // receipt, even when no changed path selected another runtime consumer.
        'production-summary'
    ]);
    const requiresImmutableBuild = selectedTiers.some(tier => immutableBuildConsumerJobs.has(tier.ciJob));
    if (requiresImmutableBuild && !selectedTiers.some(tier => tier.id === 'production-build-artifacts'))
    {
        const skippedIndex = skippedTiers.findIndex(tier => tier.id === 'production-build-artifacts');
        if (skippedIndex < 0)
        {
            throw new Error('smart gate selected an immutable build consumer without production-build-artifacts tier');
        }
        const [producer] = skippedTiers.splice(skippedIndex, 1);
        selectedTiers.push({
            ...producer,
            reason: 'selected runtime/browser job requires the immutable production build producer'
        });
    }

    const selectedTierIds = new Set(selectedTiers.map((tier) => tier.id));
    const aggregateJobs = Object.values(matrix.aggregateAuthorities ?? {});
    const selectedJobs = [...new Set([...selectedTiers.map((tier) => tier.ciJob),
        ...aggregateJobs.filter(authority => authority.summaryTierIds.some(id => selectedTierIds.has(id)))
            .map(authority => authority.ciJob)])].sort();
    const skippedJobs = [...new Set([...skippedTiers.map((tier) => tier.ciJob), ...aggregateJobs.map(authority => authority.ciJob)]
        .filter((job) => !selectedJobs.includes(job)))].sort();

    return sealContentDigest({
        schema: 'fsusblog.pr-smart-gate.v1',
        generatedAt: new Date().toISOString(),
        sourceState: identity.sourceState,
        runId: identity.runId,
        runAttempt: identity.runAttempt,
        fullMode,
        executionStage: effectivePrExecutionStage({ ...options, full: isFullSmartGateMode(options) }),
        sourceRegressionTargets: impact.sourceRegressionTargets ?? [],
        deferredQualificationTierIds: impact.deferredQualificationTierIds ?? [],
        fullQualificationTierIds: matrix.tiers.map(tier => tier.id).sort(),
        eventName: options.eventName,
        baseRef: options.baseRef,
        changedFiles,
        changedPathEvidence: options.changedPathEvidence,
        selectionReason: impact.reason,
        selectionScope: impact.selectionScope,
        qualificationEligible: false,
        selectedTiers,
        skippedTiers,
        selectedTierIds: [...selectedTierIds].sort(),
        skippedTierIds: skippedTiers.map((tier) => tier.id).sort(),
        selectedJobIds: selectedJobs,
        skippedJobIds: skippedJobs,
        summaryAuthorityJobIds: summaryAuthorityJobIds(),
        selectedJobs,
        skippedJobs,
        retentionReport: retentionReport(matrix)
    });
}

async function prSmartGateIdentity()
{
    const commit = String(process.env.FSUSBLOG_TEST_SOURCE_COMMIT ?? process.env.GITHUB_SHA ?? git(['rev-parse', 'HEAD']) ?? '').trim();
    if (!/^[a-f0-9]{40}$/u.test(commit))
    {
        throw new Error('PR smart gate plan requires a full lowercase source commit SHA');
    }
    const snapshot = await snapshotGitWorktree(root);
    const worktreeFingerprint = String(process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT ?? snapshot?.fingerprint ?? '').trim();
    if (worktreeFingerprint.replace(/^sha256:/u, '') !== snapshot.fingerprint.replace(/^sha256:/u, ''))
    {
        throw new Error('provided PR source fingerprint differs from the actual Git worktree snapshot');
    }
    if (!/^(?:sha256:)?[a-f0-9]{64}$/u.test(worktreeFingerprint))
    {
        throw new Error('PR smart gate plan requires a SHA-256 source fingerprint');
    }
    return {
        sourceState: { commit, worktreeFingerprint },
        runId: String(process.env.GITHUB_RUN_ID ?? 'local'),
        runAttempt: String(process.env.GITHUB_RUN_ATTEMPT ?? '0')
    };
}

function normalizedOutputName(value)
{
    return String(value).replace(/[^A-Za-z0-9_]/g, '_');
}

function productionBuildDomainsForJobs(selectedJobs)
{
    const jobs = new Set(selectedJobs);
    const domains = new Set();
    const add = (...values) => values.forEach(value => domains.add(value));
    if (jobs.has('backend-qps-collectors'))
    {
        add('backend-runtime');
    }
    for (const job of ['integration-runtime', 'endpoint-depth-runtime', 'resilience-runtime', 'load-smoke'])
    {
        if (jobs.has(job))
        {
            add('backend-runtime', 'test-runtime', 'generated-contracts');
        }
    }
    for (const job of [
        'release-public', 'security-runtime', 'browser-contract', 'perf-regression'
    ])
    {
        if (jobs.has(job))
        {
            add('backend-runtime', 'test-runtime', 'frontend-dist', 'wasm', 'generated-contracts');
        }
    }
    return [...domains].sort();
}

function writePrSmartGateOutputs(matrix, plan, githubOutputFile)
{
    if (!githubOutputFile)
    {
        return;
    }
    const abs = path.resolve(root, githubOutputFile);
    ensureOutputDirectory(abs);
    const selectedJobs = new Set(plan.selectedJobs);
    const selectedTierIds = new Set(plan.selectedTierIds);
    const lines = [
        `pr_smart_gate_summary=${relativeToRoot(prSmartGateSummaryFile)}`,
        `plan_content_digest=${plan.contentDigest}`,
        `plan_source_commit=${plan.sourceState.commit}`,
        `plan_source_fingerprint=${plan.sourceState.worktreeFingerprint}`,
        `plan_run_id=${plan.runId}`,
        `plan_run_attempt=${plan.runAttempt}`,
        `selected_jobs_json=${JSON.stringify(plan.selectedJobs)}`,
        `skipped_jobs_json=${JSON.stringify(plan.skippedJobs)}`,
        `production_build_domains=${productionBuildDomainsForJobs(plan.selectedJobs).join(',')}`,
        `production_build_domains_json=${JSON.stringify(productionBuildDomainsForJobs(plan.selectedJobs))}`
    ];
    const allJobs = new Set([...plan.selectedJobs, ...plan.skippedJobs]);
    for (const job of [...allJobs].sort())
    {
        lines.push(`${normalizedOutputName(job)}=${selectedJobs.has(job) ? 'true' : 'false'}`);
        const payload = buildCiJobMatrix(matrix, job, selectedTierIds, true);
        const maxParallel = payload.include.length === 0
            ? 1
            : Math.max(...payload.include.map((entry) => Number(entry.max_parallel || 1)));
        lines.push(`${normalizedOutputName(job)}_matrix=${JSON.stringify(payload)}`);
        lines.push(`${normalizedOutputName(job)}_max_parallel=${maxParallel}`);
    }
    fs.appendFileSync(abs, `${lines.join('\n')}\n`);
}

function validateApplicablePrExecution(matrix, plan)
{
    const errors = validateReleaseFinalStaticBoundary({ matrix,
        scriptSource: fs.readFileSync(path.join(root, 'tools/test/lanes/release-final.sh'), 'utf8'),
        repositoryRoot: root,
        selectedTierIds: plan.fullMode ? null : new Set(plan.selectedTierIds) });
    if (errors.length)
    {
        throw new Error(`applicable PR execution authority rejected:\n${errors.join('\n')}`);
    }
}

async function ciPrPlan(matrix, args)
{
    const options = parsePrSmartGateOptions(args);
    if (process.env.FSUSBLOG_CI_PR_SMART_GATE_PLAN && process.env.FSUSBLOG_PR_PLAN_DIGEST)
    {
        const existing = process.env.FSUSBLOG_CI_PR_SMART_GATE_PLAN;
        await loadSelectedTierIds(matrix, existing, prImpactCallerContext(process.env, {
            baseRef: options.baseRef, eventName: options.eventName,
            full: isFullSmartGateMode(options), stage: options.stage
        }));
        const plan = JSON.parse(fs.readFileSync(path.resolve(root, existing), 'utf8'));
        writeTextOutput(`${JSON.stringify(plan, null, 2)}\n`, options.outFile ?? prSmartGateSummaryFile, 'matrix:ci-pr-plan');
        writePrSmartGateOutputs(matrix, plan, options.githubOutputFile);
        return;
    }
    const plan = buildPrSmartGatePlan(matrix, options, await prSmartGateIdentity());
    validateApplicablePrExecution(matrix, plan);
    const defaultOut = options.outFile ?? prSmartGateSummaryFile;
    writeTextOutput(`${JSON.stringify(plan, null, 2)}\n`, defaultOut, 'matrix:ci-pr-plan');
    fs.mkdirSync(path.dirname(prSmartGateSummaryFile), { recursive: true });
    fs.writeFileSync(prSmartGateSummaryFile, `${JSON.stringify(plan, null, 2)}\n`);
    writePrSmartGateOutputs(matrix, plan, options.githubOutputFile);
}

async function ciPrSmart(matrix, args)
{
    const options = parsePrSmartGateOptions(args);
    const plan = buildPrSmartGatePlan(matrix, options, await prSmartGateIdentity());
    validateApplicablePrExecution(matrix, plan);
    if (options.planOnly === true)
    {
        console.log(JSON.stringify(plan, null, 2));
        return;
    }
    fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
    fs.writeFileSync(path.join(root, '.tmp/pr-plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
    if (plan.selectedTierIds.every(id => sourceCoordinationTierIds.has(id)))
    {
        await runSourceCoordinationTier(matrix, 'source-governance', ['--no-deps'], prImpactCallerContext(process.env,
            { baseRef: options.baseRef, eventName: options.eventName, full: isFullSmartGateMode(options), stage: options.stage, expectedDigest: plan.contentDigest }));
        return;
    }
    const byId = tierMap(matrix);
    const declaredTiers = plan.selectedTierIds.map((tierId) => byId.get(tierId)).filter(Boolean);
    if (declaredTiers.length === 0)
    {
        return;
    }
    const systemResources = logicalTierSystemResources();
    let tiers = resolveLogicalTierResources(declaredTiers, systemResources);
    const targetTierId = 'ci-pr-smart';
    const schedulerOptions = { resume: false };
    const { runsRoot, runId } = schedulerRunIdentity(targetTierId, schedulerOptions);
    const { sourceState: buildSourceState } = await collectSchedulerSourceState(root);
    const behaviorDocAdmission = await establishBehaviorDocAdmission({
        repositoryRoot: root,
        runId
    });
    tiers = bindBehaviorDocAdmissionVerification(tiers, behaviorDocAdmission);
    const currentRunPreexecutedTierBindings = [];
    appendCurrentRunBehaviorDocAdmissionBinding({
        bindings: currentRunPreexecutedTierBindings,
        tiers,
        admission: behaviorDocAdmission,
        schedulerRunId: runId,
        sourceState: buildSourceState
    });
    const runNamespace = namespaceFor({ ciJob: targetTierId, id: targetTierId }, null, runId);
    const lifecycle = await runProductionBuildLifecycle({
        prepareOptions: {
            root,
            runId,
            sourceState: buildSourceState,
            namespace: runNamespace
        },
        async execute({ buildLayout, recordSchedulerResult, setFinalization, throwIfInterrupted })
        {
            const scheduledTiers = prependManagedProductionBuildGc(tiers, runId);
            throwIfInterrupted();
            prepareNamespaceEnvironmentIfNeeded(tiers, runNamespace, {
                runId,
                sourceState: buildSourceState,
                buildLayout
            });
            resetFreshJobSummaries(tiers.map((tier) => [tier, {}]));
            const result = recordSchedulerResult(
                await runDag({
                    registerManagedProcess: (identity, _tier, authority) =>
                        registerProductionBuildCompiler(buildLayout, identity, authority),
                    ...mysqlServiceSchedulerOptions(buildLayout, scheduledTiers),
                    sourceState: buildSourceState,
                    namespace: runNamespace,
                    tiers: scheduledTiers,
                    root,
                    runsRoot,
                    runId,
                    targetTierId,
                    mode: 'fresh',
                    resume: false,
                    currentRunPreexecutedTierBindings,
                    supersedesUniverse: matrix.tiers,
                    coverageRegistry: loadCoverageRegistry().entries,
                    maxParallel: systemResources.availableCpuUnits,
                    systemResources,
                    teeOutput: true,
                    beforeTierStart()
                    {
                        verifyBehaviorDocAdmissionState(behaviorDocAdmission, root);
                    },
                    onSourceState(sourceState)
                    {
                        bindScheduledBuildLayoutSource(buildLayout, sourceState);
                    },
                    envForTier(tier)
                    {
                        const env = applyNamespaceBuildEnvironment(
                            tier,
                            productionBuildEnvironment(buildLayout, {
                                ...loadNamespaceEnv(runNamespace),
                                CURRENT_TIER: tier.id,
                                MATRIX_JOB: tier.ciJob,
                                FSUSBLOG_TEST_NAMESPACE: runNamespace,
                                FSUSBLOG_TEST_RUN_ID: runId,
                                FSUSBLOG_CI_JOB_ID: tier.ciJob,
                                FSUSBLOG_CI_JOB_SCHEDULER: 'dag',
                                FSUSBLOG_CI_PR_SMART_GATE_PLAN: '.tmp/pr-plan.json',
                                ...prImpactConsumerEnvironment(prImpactCallerContext(process.env, {
                                    baseRef: options.baseRef, eventName: options.eventName,
                                    full: isFullSmartGateMode(options), stage: options.stage, expectedDigest: plan.contentDigest
                                })),
                                FSUSBLOG_BEHAVIOR_DOC_ADMISSION_RECEIPT:
                                    behaviorDocAdmission.receiptFile,
                                FSUSBLOG_BEHAVIOR_DOC_ADMISSION_DIGEST:
                                    behaviorDocAdmission.contentDigest,
                                FSUSBLOG_BEHAVIOR_DOC_ADMISSION_RUN_ID:
                                    behaviorDocAdmission.runId
                            })
                        );
                        Object.assign(env, resourceEnvironmentForTier(tier, env));
                        applyUxViewportResumeEnvironment(env, tier, false);
                        return applyMatrixFixtureProfileEnvironment(tier, env);
                    },
                    onTierStart(tier)
                    {
                        emitTierReproductionHint(tier, { noDeps: true });
                        console.error(`[matrix:ci-pr-smart] started ${tier.id}: ${tier.command}`);
                    },
                    onTierComplete(tier, tierResult)
                    {
                        const startedAt = Date.now() - tierResult.durationMs;
                        const success = tierResult.status === 'success';
                        writeJobSummary(matrix, tier, success ? 'success' : 'failure', startedAt, {
                            schedulerRunId: runId,
                            failureStage: success ? null : stageForTier(tier),
                            rootCause: success ? null : tierResult.reason
                        });
                        console.error(`[matrix:ci-pr-smart] ${tier.id} ${tierResult.status}`);
                    }
                })
            );
            console.error(
                `[matrix:ci-pr-smart] run=${result.runId} checkpoint=${relativeToRoot(result.checkpointPath)}`
            );
            setFinalization({
                status:
                    result.status === 'success' ? 'success' : result.failure?.signal ? 'cancelled' : 'failure',
                primaryFailure: result.status === 'success' ? null : result.failure
            });
            return result;
        }
    });
    const result = lifecycle.operationResult;
    if (result.status !== 'success')
    {
        process.exitCode = Number(result.failure?.exitCode) || 1;
    }
}

function ciPlan(matrix, format, outFile)
{
    const plan = { ...buildCiPlan(matrix, format),
        requiredEvidenceDependencies: createRequiredEvidenceDependencies(matrix) };
    plan.contentDigest = requiredEvidencePlanDigest(plan);
    writeTextOutput(`${JSON.stringify(plan, null, 2)}\n`, outFile, 'matrix:ci-plan');
}

export function buildEvidencePlan(matrix, identity = requiredEvidencePlanIdentity(),
    planningMetadata = projectLogicalTierPlanningMetadata(matrix.tiers))
{
    const plan = {
        schema: 'fsusblog.release-evidence.test-plan.v1',
        generatedAt: new Date().toISOString(),
        commit: identity.sourceCommit,
        namespace: identity.namespace,
        runId: identity.runId,
        requiredEvidenceDependencies: createRequiredEvidenceDependencies(matrix, identity),
        tiers: [...matrix.tiers].sort((left, right) => left.id.localeCompare(right.id)).map((tier) => ({
            id: tier.id,
            ciJob: tier.ciJob,
            command: tier.command,
            executionDependsOn: tierExecutionDependencies(tier),
            requiresEvidenceFrom: tier.requiresEvidenceFrom ?? [],
            timeoutMinutes: tier.timeoutMinutes,
            phase: tier.phase,
            cost: tier.cost,
            resourceClass: tier.resourceClass,
            cpuWeight: tier.cpuWeight,
            memoryWeight: tier.memoryWeight,
            minCpuUnits: tier.minCpuUnits,
            parallelism: tier.parallelizable ? 'machine' : 'serial',
            requiresBootstrap: tier.requiresBootstrap,
            requiresNode: tier.requiresNode,
            requiresDotnet: tier.requiresDotnet,
            requiresPlaywright: tier.requiresPlaywright,
            evidenceClass: tier.evidenceClass ?? 'correctness',
            playwrightWorkers: planningMetadata.get(tier.id).playwrightWorkers,
            cacheProfile: tier.cacheProfile,
            shardable: tier.shardable,
            sharding: tier.shardable ? 'machine' : 'single',
            artifacts: tier.artifacts,
            evidence: tier.evidence,
            risk: tier.risk,
            cadence: tier.cadence,
            requiredFor: tier.requiredFor,
            localOnly: tier.localOnly,
            nightlyOnly: tier.nightlyOnly,
            manualOnly: tier.manualOnly === true
        }))
    };
    plan.contentDigest = requiredEvidencePlanDigest(plan);
    return plan;
}

function evidencePlan(matrix, outFile)
{
    const plan = buildEvidencePlan(matrix);
    const abs = path.resolve(root, outFile ?? '.tmp/release-evidence/test-plan.json');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, `${JSON.stringify(plan, null, 2)}\n`);
    console.log(`[matrix:evidence] wrote ${path.relative(root, abs)}`);
}

function preflight(matrix)
{
    const checkedDirectories = [
        '.tmp',
        '.tmp/release-evidence',
        '.tmp/gate-logs',
        '.tmp/env',
        '.tmp/docs'
    ];
    const checkedFiles = [
        'tests/matrix.yml',
        'tests/matrix.schema.json',
        'tests/coverage-registry.json',
        '.github/workflows/quality-gate.yml',
        'tools/run-test-matrix.mjs',
        'tools/check-workflow-matrix-sync.mjs',
        'tools/test.sh',
        'tools/ci/check-flaky-registry.mjs',
        'tools/ci/check-flaky-evidence.mjs',
        'tools/ci/run-flaky-governed.mjs',
        'tests/flaky.yml'
    ];
    const errors = [];

    for (const rel of checkedDirectories)
    {
        const abs = path.join(root, rel);
        try
        {
            fs.mkdirSync(abs, { recursive: true });
            fs.accessSync(abs, fs.constants.W_OK);
        }
        catch (error)
        {
            errors.push(`${rel} is not writable: ${error.message}`);
        }
    }

    for (const rel of checkedFiles)
    {
        if (!fs.existsSync(path.join(root, rel)))
        {
            errors.push(`missing required file: ${rel}`);
        }
    }

    const nodeMajor = Number(process.versions.node.split('.')[0]);
    if (!Number.isFinite(nodeMajor) || nodeMajor < 20)
    {
        errors.push(`Node.js 20 or newer is required, got ${process.versions.node}`);
    }

    const gitRoot = git(['rev-parse', '--show-toplevel']);
    if (!gitRoot)
    {
        errors.push('git metadata is unavailable; run from a checked-out repository');
    }
    else if (path.resolve(gitRoot) !== root)
    {
        errors.push(`git root mismatch: expected ${root}, got ${gitRoot}`);
    }

    for (const matrixError of validateMatrix(matrix))
    {
        errors.push(`matrix validation: ${matrixError}`);
    }

    const writeChecks = [
        '.tmp/ci-plan.json',
        '.tmp/release-evidence/test-plan.json',
        '.tmp/gate-logs/preflight.json'
    ];
    for (const rel of writeChecks)
    {
        const abs = path.join(root, rel);
        try
        {
            ensureOutputDirectory(abs);
            const probe = `${abs}.write-check`;
            fs.writeFileSync(probe, 'ok\n');
            fs.unlinkSync(probe);
        }
        catch (error)
        {
            errors.push(`cannot write ${rel}: ${error.message}`);
        }
    }

    const log = {
        schema: 'fsusblog.ci-preflight.v1',
        generatedAt: new Date().toISOString(),
        ok: errors.length === 0,
        node: process.versions.node,
        gitHead: git(['rev-parse', 'HEAD']),
        checkedDirectories,
        checkedFiles,
        writeChecks,
        errors
    };

    try
    {
        ensureOutputDirectory(preflightLogFile);
        fs.writeFileSync(preflightLogFile, `${JSON.stringify(log, null, 2)}\n`);
    }
    catch (error)
    {
        errors.push(`cannot write ${relativeToRoot(preflightLogFile)}: ${error.message}`);
    }

    if (errors.length > 0)
    {
        writeJobSummary(matrix, tierMap(matrix).get('validate-matrix'), 'failure', Date.now(), {
            failureStage: 'setup',
            stage: 'setup',
            rootCause: errors[0],
            jobId: 'validate-matrix'
        });
        for (const error of errors)
        {
            console.error(`[matrix:preflight] ${error}`);
        }
        process.exit(1);
    }

    // The preflight tier declares the authoritative test plan as its evidence.
    // Generate it only after validation succeeds so a clean checkout cannot
    // report a successful tier with a missing output.
    evidencePlan(matrix, '.tmp/release-evidence/test-plan.json');

    writeJobSummary(matrix, tierMap(matrix).get('validate-matrix'), 'success', Date.now(), {
        failureStage: null,
        rootCause: null,
        stage: 'setup',
        jobId: 'validate-matrix'
    });
    console.log(`[matrix:preflight] ok (${checkedDirectories.length} directories, ${checkedFiles.length} files)`);
    console.log(`[matrix:preflight] wrote ${relativeToRoot(preflightLogFile)}`);
    console.log('[matrix:preflight] To reproduce locally: ./tools/test.sh ci-tier validate-matrix');
}

function git(args)
{
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : null;
}

function usage()
{
    console.log(`Usage:
  node tools/run-test-matrix.mjs validate
  node tools/run-test-matrix.mjs preflight
  node tools/run-test-matrix.mjs list
  node tools/run-test-matrix.mjs plan <tier>
  node tools/run-test-matrix.mjs run <tier> [--plan-only] [--no-deps] [--shard i/n] [--fresh|--resume] [--max-parallel n]
  node tools/run-test-matrix.mjs ci-tier <tier> [--plan-only] [--no-deps] [--shard i/n] [--fresh|--resume] [--max-parallel n]
  node tools/run-test-matrix.mjs ci-job <job> [--plan-only] [--shard i/n] [--fresh|--resume] [--max-parallel n]
  node tools/run-test-matrix.mjs ci-job-matrix <job> [--out file] [--github-output file] [--pr-plan file]
  node tools/run-test-matrix.mjs aggregate <job> [--dry-run] [--out file] [--github-needs json]
  node tools/run-test-matrix.mjs ci-fast [--plan-only] [--fresh|--resume] [--max-parallel n]
  node tools/run-test-matrix.mjs ci-production [--plan-only] [--fresh|--resume] [--max-parallel n]
  node tools/run-test-matrix.mjs ci-release-final [--plan-only] [--fresh|--resume] [--max-parallel n]
  node tools/run-test-matrix.mjs ci-pr-plan [--changed-files file] [--base-ref ref] [--out .tmp/pr-plan.json] [--github-output file]
  node tools/run-test-matrix.mjs ci-pr-smart [--changed-files file] [--base-ref ref] [--stage qualification|source-integration] [--full] [--plan-only]
  node tools/run-test-matrix.mjs ci-plan [--format github-actions] [--out .tmp/ci-plan.json]
  node tools/run-test-matrix.mjs evidence-plan [--out .tmp/release-evidence/test-plan.json]

Compatibility:
  ./tools/test.sh <tier> delegates to "run <tier>".
  "./tools/test.sh production --plan-only" prints the DAG without executing it.
  "./tools/test.sh production" is the production-ci-gate: release evidence may be schema-valid collected-blocked.
  "./tools/test.sh release-closeout" is the release-closeout-gate: it requires check-release-evidence-manifest.mjs --require-ok.
  "./tools/test.sh release-final" is the final publish credential: no skip, no collected-blocked, strict coverage, strict shards, artifact-bound evidence.
`);
}

function optionValue(args, name, fallback = null)
{
    const flag = `--${name}`;
    const inline = args.find((arg) => arg.startsWith(`${flag}=`));
    if (inline)
    {
        return inline.slice(flag.length + 1);
    }
    const index = args.indexOf(flag);
    if (index >= 0)
    {
        return args[index + 1];
    }
    return fallback;
}

function consumesProductionCorrectness(command, args)
{
    if (args.includes('--plan-only'))
    {
        // Plan-only invocations only print the resolved DAG: they execute no
        // producer and consume no correctness evidence, so clean-attempt
        // admission cannot attach to this invocation.
        return false;
    }
    return (['run', 'ci-tier'].includes(command) && args[0] === 'production-correctness')
        || command === 'ci-production'
        || command === 'ci-release-final';
}

// BEHAVIOR-OWNER: browserless-production-correctness
async function main()
{
    const [command, ...args] = process.argv.slice(2);
    if (!command || command === 'help' || command === '--help' || command === '-h')
    {
        usage();
        return;
    }

    const pureCoordination = ['run', 'ci-tier', 'ci-job'].includes(command) && sourceCoordinationTierIds.has(args[0]);
    const applicablePlanFile = process.env.FSUSBLOG_CI_PR_SMART_GATE_PLAN;
    const consumesApplicablePlan = Boolean(applicablePlanFile) && !pureCoordination
        && !['validate-declarations', 'ci-pr-plan', 'ci-pr-smart'].includes(command);
    const matrix = loadMatrix({ validateDependencyFields: command !== 'validate',
        declarationsOnly: consumesApplicablePlan || pureCoordination || ['validate-declarations', 'ci-pr-plan', 'ci-pr-smart', 'ci-job-matrix'].includes(command) });
    if (consumesApplicablePlan)
    {
        const selected = await loadSelectedTierIds(matrix, applicablePlanFile);
        if ((['run', 'ci-tier'].includes(command) && !selected.has(normalizeTierId(args[0])))
            || (command === 'ci-job' && !effectiveCiJobTiers(matrix, args[0]).every(tier => selected.has(tier.id))))
        {
            throw new Error('requested execution is outside the independently rebuilt applicable PR plan');
        }
    }
    if (command === 'validate-declarations')
    {
        const errors = [...validateImpactDeclarations(matrix), ...validateMatrixSchema(matrix)];
        if (errors.length)
        {
            throw new Error(errors.join('\n'));
        }
        console.log(`[matrix] global declarations ok (${matrix.tiers.length} tiers); no execution qualification`);
        return;
    }
    if (!pureCoordination && !['ci-pr-plan', 'ci-pr-smart', 'ci-job-matrix'].includes(command))
    {
        validateCorrectnessAttemptMigration(root);
    }
    if (consumesProductionCorrectness(command, args))
    {
        const contextPath = process.env.FSUSBLOG_CURRENT_RUN_EVIDENCE_CONTEXT;
        if (!contextPath)
        {
            throw new Error('production correctness admission requires independent current-run context');
        }
        const context = validateCurrentRunEvidenceContext(JSON.parse(fs.readFileSync(path.resolve(root, contextPath), 'utf8')));
        const source = sealSourceIdentity(root);
        requireCleanAttemptConsumerAdmission({
            consumerId: 'production-correctness',
            repositoryRoot: root,
            candidateBinding: { sourceCommit: source.sourceCommit,
                worktreeFingerprint: `sha256:${source.worktreeFingerprint.replace(/^sha256:/u, '')}`,
                schedulerRunId: context.schedulerRunId, buildIdentity: context.buildIdentity.digest }
        });
    }
    if (command === 'validate')
    {
        const errors = [
            ...validateMatrix(matrix),
            ...validateRuntimeStateDomainCatalog().map((error) => `runtime state-domain: ${error}`),
            ...validateFixtureCatalogs().map((error) => `fixture catalog: ${error}`),
            ...validateFixtureProfileMatrix(matrix).map((error) => `fixture profile matrix: ${error}`)
        ];
        if (errors.length > 0)
        {
            for (const error of errors)
            {
                console.error(`[matrix] ${error}`);
            }
            process.exit(1);
        }
        console.log(`[matrix] ok (${matrix.tiers.length} tiers)`);
        return;
    }
    if (command === 'preflight')
    {
        preflight(matrix);
        return;
    }
    if (command === 'list')
    {
        listTiers(matrix);
        return;
    }
    if (command === 'plan')
    {
        const tiers = planTier(matrix, args[0]);
        printPlan(tiers, matrix, projectLogicalTierPlanningMetadata(tiers));
        return;
    }
    if (command === 'run')
    {
        await runTier(matrix, args[0], args.slice(1));
        return;
    }
    if (command === 'ci-tier')
    {
        await runTier(matrix, args[0], args.slice(1));
        return;
    }
    if (command === 'ci-job')
    {
        await runCiJob(matrix, args[0], args.slice(1));
        return;
    }
    if (command === 'ci-job-matrix')
    {
        await ciJobMatrix(matrix, args[0], args.slice(1));
        return;
    }
    if (command === 'aggregate')
    {
        aggregateCiJob(matrix, args[0], args.slice(1));
        return;
    }
    if (command === 'ci-fast')
    {
        await runLocalAggregateWorkflow(matrix, 'fast-summary', args);
        return;
    }
    if (command === 'ci-production')
    {
        await runTier(matrix, 'production', args);
        return;
    }
    if (command === 'ci-release-final')
    {
        await runTier(matrix, 'release-final', args);
        return;
    }
    if (command === 'ci-plan')
    {
        ciPlan(matrix, optionValue(args, 'format', 'json'), optionValue(args, 'out'));
        return;
    }
    if (command === 'ci-pr-plan')
    {
        await ciPrPlan(matrix, args);
        return;
    }
    if (command === 'ci-pr-smart')
    {
        await ciPrSmart(matrix, args);
        return;
    }
    if (command === 'evidence-plan')
    {
        evidencePlan(matrix, optionValue(args, 'out'));
        return;
    }

    throw new Error(`unknown command: ${command}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    try
    {
        await main();
    }
    catch (error)
    {
        console.error(`[matrix] ${error.message}`);
        if (process.env.FSUSBLOG_MATRIX_DEBUG_STACK === '1' && error?.stack)
        {
            console.error(error.stack);
        }
        process.exitCode = Number(error?.exitCode) || 1;
    }
}
