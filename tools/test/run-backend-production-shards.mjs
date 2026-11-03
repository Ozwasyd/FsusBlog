#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
    composeBackendPlatformFilter,
    parseBackendPlatformResultRows,
    projectBackendPlatformPlan,
    reconcileBackendPlatformOutcome,
    selectBackendPlatformRecords
} from './backend-platform-selection.mjs';
const {cleanupOrphanDotnetBuildServers, selectOrphanDotnetBuildServers} = await import(new URL('../test-matrix/dotnet-build-server-cleanup.mjs', import.meta.url));
import {
    allocateBackendTopologyProcessors,
    backendTopologyDefaults,
    planBackendProductionTopology
} from './backend-production-topology.mjs';
const {productionDotnetArtifacts, resolveProductionBuildLayout} = await import(new URL('../test-matrix/production-build-layout.mjs', import.meta.url));
const {resolveCgroupLimits} = await import(new URL('../test-matrix/production-resource-enforcement.mjs', import.meta.url));
import { findCSharpClassDeclaration } from './csharp-source-mask.mjs';
import {
    projectTraitMembership,
    readVstestDiscoveryDiagnostic
} from './vstest-discovery-diagnostic.mjs';
const {prepareCoverageShard, resolveCoverageBinding, writeCoverageUniverse} = await import(new URL('../coverage/backend-coverage-pipeline.mjs', import.meta.url));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const productionFreshOutputRoot = String(process.env.FSUSBLOG_PRODUCTION_FRESH_OUTPUT_ROOT ?? '').trim();

function productionFreshOutputPath(partition, ...segments)
{
    if (productionFreshOutputRoot)
    {
        return path.join(path.resolve(productionFreshOutputRoot), partition, ...segments);
    }
    return null;
}

function productionTrxRoot()
{
    const configured = String(process.env.FSUSBLOG_BACKEND_TRX_DIR ?? '').trim();
    return configured ? path.join(path.resolve(configured), 'production')
        : productionFreshOutputPath('reports', 'trx', 'backend', 'production')
    ?? path.join(root, '.tmp/test-results/backend/production');
}

function productionCoverageRoot()
{
    const configured = String(process.env.FSUSBLOG_COVERAGE_ROOT ?? '').trim();
    return configured ? path.join(path.resolve(configured), 'backend', 'production')
        : productionFreshOutputPath('coverage', 'backend', 'production')
    ?? path.join(root, '.tmp/coverage/backend/production');
}
const project = 'tests/backend/FsusBlog.Server.Tests.csproj';
const productionBuildLayout = process.env.FSUSBLOG_TEST_RUN_ID
    ? resolveProductionBuildLayout({ root })
    : null;
const productionDotnet = productionBuildLayout
    ? productionDotnetArtifacts(productionBuildLayout)
    : null;
const testAssembly = productionDotnet
    ? path.relative(root, productionDotnet.testDll).replaceAll(path.sep, '/')
    : 'tests/backend/bin/Release/net10.0/FsusBlog.Server.Tests.dll';
const productionBaseFilter = 'Category!=Integration&Category!=Performance&Fixture!=LocalRedis';
const productionFilter = composeBackendPlatformFilter(productionBaseFilter);
const projectedCategories = [
    'ApiIntegration',
    'SecurityStateMachine',
    'Concurrency',
    'Property',
    'GoldenContract'
];
const shardAffinities = ['EndpointContractApplication'];
const weightedDependencies = ['Docker'];
const dependencyPlanningMultiplier = 2;
const governanceRequirementTest = 'FsusBlog.Server.Tests.Unit.BackendTestGovernanceTests.Issue40Requirements_HaveEvidenceAndRiskTraceability';
const backendPostgresContainerPattern = /^fsus-pg-.+-(\d+)-[0-9a-f]+$/u;

function sha256(value)
{
    return createHash('sha256').update(value).digest('hex');
}

function canonicalBackendBuildBinding()
{
    const runId = String(process.env.FSUSBLOG_TEST_RUN_ID ?? '').trim();
    if (!runId)
    {
        return null;
    }
    const receiptFile = path.join(root, '.tmp/test-runs', runId, 'backend-tests-ready.json');
    if (!fs.existsSync(receiptFile))
    {
        throw new Error('canonical backend Release build receipt is missing');
    }
    const receiptBytes = fs.readFileSync(receiptFile);
    const receipt = JSON.parse(receiptBytes);
    const testDllPath = path.relative(root, path.resolve(root, testAssembly)).replaceAll(path.sep, '/');
    const testDllDigest = `sha256:${sha256(fs.readFileSync(path.resolve(root, testAssembly)))}`;
    if (receipt?.schema !== 'fsusblog.local-production.backend-tests-ready.v1'
    || receipt.status !== 'success'
    || receipt.physicalBundleId !== 'backend-tests'
    || receipt.schedulerRunId !== runId
    || receipt.buildLayout?.runId !== runId
    || receipt.buildLayout?.sourceCommit !== (process.env.FSUSBLOG_TEST_SOURCE_COMMIT ?? null)
    || receipt.buildLayout?.sourceFingerprint !== (process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT ?? null)
    || receipt.testDll?.path !== testDllPath
    || receipt.testDll?.contentDigest !== testDllDigest)
    {
        throw new Error('canonical backend Release build receipt does not bind the current source, run, and test DLL digest');
    }
    return {
        receipt: path.relative(root, receiptFile).replaceAll(path.sep, '/'),
        receiptDigest: `sha256:${sha256(receiptBytes)}`,
        runId,
        sourceCommit: receipt.buildLayout.sourceCommit,
        sourceFingerprint: receipt.buildLayout.sourceFingerprint,
        testDll: { path: testDllPath, contentDigest: testDllDigest }
    };
}

function positiveInteger(value, fallback)
{
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function backendPostgresContainerOwnerPid(containerName)
{
    const match = backendPostgresContainerPattern.exec(String(containerName ?? '').trim());
    if (!match)
    {
        return null;
    }
    return positiveInteger(match[1], null);
}

export function staleBackendPostgresContainers(containerNames, {
    processExists = (pid) => fs.existsSync(`/proc/${pid}`)
} = {})
{
    if (!Array.isArray(containerNames))
    {
        throw new Error('backend PostgreSQL cleanup requires a container-name array');
    }
    if (typeof processExists !== 'function')
    {
        throw new Error('backend PostgreSQL cleanup requires a process probe');
    }
    return containerNames.filter((containerName) =>
    {
        const ownerPid = backendPostgresContainerOwnerPid(containerName);
        return ownerPid !== null && !processExists(ownerPid);
    });
}

export function backendProductionDatabaseNamespace(role, {
    runId = process.env.FSUSBLOG_TEST_RUN_ID ?? 'local',
    runnerPid = process.pid
} = {})
{
    if (role !== 'main')
    {
        throw new Error(`unknown backend database namespace role: ${role}`);
    }
    const pid = positiveInteger(runnerPid, null);
    if (!pid)
    {
        throw new Error('backend database namespace requires a positive runner PID');
    }
    return `bp-${sha256(`${runId}:${pid}`).slice(0, 10)}-m`;
}

export function backendRunOwnerPid(runId)
{
    const match = /^.+-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d{3}-(\d+)$/u.exec(String(runId ?? '').trim());
    return match ? positiveInteger(match[1], null) : null;
}

export function staleBackendBuildServerPids(processes, {
    repositoryRoot = root,
    currentRunId = process.env.FSUSBLOG_TEST_RUN_ID ?? '',
    currentNamespace = process.env.FSUSBLOG_TEST_NAMESPACE ?? '',
    currentStartSource = process.env.FSUSBLOG_TEST_EXECUTION_SOURCE ?? '',
    runsRoot = path.join(repositoryRoot, '.tmp/test-runs'),
    runActivity
} = {})
{
    return selectOrphanDotnetBuildServers(processes, {
        root: repositoryRoot,
        currentRunId,
        currentNamespace,
        currentStartSource,
        includeCurrentBinding: true,
        runsRoot,
        runActivity
    }).map(({ pid }) => pid);
}

function positiveNumber(value, fallback)
{
    const parsed = Number(String(value ?? ''));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function configuredPositiveInteger(value, label)
{
    if (value === undefined)
    {
        return null;
    }
    const parsed = Number(String(value));
    if (!Number.isInteger(parsed) || parsed < 1)
    {
        throw new Error(`${label} must be a positive integer`);
    }
    return parsed;
}

function schedulerGrantConfiguration(env = process.env)
{
    const grantFile = String(env.FSUSBLOG_SCHEDULER_RESOURCE_GRANT_FILE ?? '').trim();
    const tierId = String(env.FSUSBLOG_SCHEDULER_RESOURCE_GRANT_TIER_ID ?? '').trim();
    if (!grantFile && !tierId)
    {
        return null;
    }
    if (!grantFile || !tierId)
    {
        throw new Error('backend production scheduler grant requires both resource grant file and tier id');
    }
    const runId = String(env.FSUSBLOG_TEST_RUN_ID ?? '').trim();
    if (!runId)
    {
        throw new Error('backend production scheduler grant requires FSUSBLOG_TEST_RUN_ID');
    }
    return { grantFile: path.resolve(grantFile), tierId, runId };
}

export function readBackendSchedulerResourceGrant({
    env = process.env,
    readFile = (file) => fs.readFileSync(file, 'utf8')
} = {})
{
    const configuration = schedulerGrantConfiguration(env);
    if (!configuration)
    {
        return null;
    }
    let document;
    try
    {
        document = JSON.parse(readFile(configuration.grantFile));
    }
    catch (error)
    {
        throw new Error(
            `backend production scheduler resource grant is unreadable: ${configuration.grantFile}`,
            { cause: error }
        );
    }
    if (document?.schema !== 'fsusblog.test-matrix.resource-grants.v1')
    {
        throw new Error('backend production scheduler resource grant has an invalid schema');
    }
    if (document.runId !== configuration.runId)
    {
        throw new Error(
            `backend production scheduler resource grant runId mismatch: expected ${configuration.runId}, received ${document.runId ?? '<missing>'}`
        );
    }
    if (!document.grants || !Object.hasOwn(document.grants, configuration.tierId))
    {
        throw new Error(`backend production scheduler resource grant is missing tier ${configuration.tierId}`);
    }
    const grant = document.grants[configuration.tierId];
    const resourceBudget = document.resourceBudget;
    const cpuUnits = Number(grant?.cpuUnits);
    const memoryGiB = Number(grant?.memoryGiB);
    const budgetCpuUnits = Number(resourceBudget?.cpuUnits);
    const budgetMemoryGiB = Number(resourceBudget?.memoryGiB);
    if (!Number.isInteger(cpuUnits) || cpuUnits < 1 || !positiveNumber(memoryGiB, null))
    {
        throw new Error(`backend production scheduler resource grant is invalid for tier ${configuration.tierId}`);
    }
    if (!Number.isInteger(budgetCpuUnits) || budgetCpuUnits < 1 || !positiveNumber(budgetMemoryGiB, null))
    {
        throw new Error('backend production scheduler resource budget is invalid');
    }
    if (cpuUnits > budgetCpuUnits || memoryGiB > budgetMemoryGiB)
    {
        throw new Error(`backend production scheduler resource grant exceeds its resource budget for tier ${configuration.tierId}`);
    }
    return {
        grantFile: configuration.grantFile,
        tierId: configuration.tierId,
        runId: configuration.runId,
        cpuUnits,
        memoryGiB,
        resourceBudget: {
            cpuUnits: budgetCpuUnits,
            memoryGiB: budgetMemoryGiB
        }
    };
}

export function resolveBackendPotentialProcessCount(resourceGrant, {
    availableCpu = os.availableParallelism(),
    totalMemoryGiB = os.totalmem() / (1024 ** 3)
} = {})
{
    if (!resourceGrant)
    {
        return null;
    }
    const hostCpu = positiveInteger(availableCpu, null);
    const hostMemoryGiB = positiveNumber(totalMemoryGiB, null);
    if (!hostCpu || !hostMemoryGiB)
    {
        throw new Error('backend production scheduler potential requires valid host CPU and memory capacity');
    }
    const { cpuUnits, memoryGiB } = resourceGrant.resourceBudget ?? {};
    if (!Number.isInteger(cpuUnits) || cpuUnits < 1 || !positiveNumber(memoryGiB, null))
    {
        throw new Error('backend production scheduler potential requires a valid resource budget');
    }
    if (cpuUnits > hostCpu || memoryGiB > hostMemoryGiB)
    {
        throw new Error('backend production scheduler resource budget exceeds host CPU or memory capacity');
    }
    const potentialProcessCount = Math.min(
        hostCpu,
        cpuUnits,
        Math.floor(memoryGiB / backendTopologyDefaults.memoryGiBPerTesthost),
        backendTopologyDefaults.maxTesthosts
    );
    if (potentialProcessCount < 2)
    {
        throw new Error('backend production scheduler resource budget cannot support two testhosts');
    }
    return potentialProcessCount;
}

export function readBackendResourceGrantAfterBenchmark({
    env = process.env,
    initialGrant,
    repositoryRoot = root,
    exists = (file) => fs.existsSync(file),
    readFile = (file) => fs.readFileSync(file, 'utf8'),
    readSchedulerGrant = () => readBackendSchedulerResourceGrant({ env })
} = {})
{
    const cpuUnits = Number(initialGrant?.cpuUnits);
    const memoryGiB = Number(initialGrant?.memoryGiB);
    if (!Number.isInteger(cpuUnits) || cpuUnits < 1 || !positiveNumber(memoryGiB, null))
    {
        throw new Error('backend production benchmark barrier requires a valid initial STEP grant');
    }
    const runId = String(env.FSUSBLOG_TEST_RUN_ID ?? '').trim();
    if (!runId)
    {
        throw new Error('backend production benchmark barrier requires FSUSBLOG_TEST_RUN_ID');
    }
    const markerFile = path.join(repositoryRoot, '.tmp/test-runs', runId, 'benchmark-build-ready.json');
    if (!exists(markerFile))
    {
        return { cpuUnits, memoryGiB };
    }
    let marker;
    try
    {
        marker = JSON.parse(readFile(markerFile));
    }
    catch (error)
    {
        throw new Error(`backend production benchmark readiness marker is unreadable for ${runId}`, { cause: error });
    }
    if (marker?.schema !== 'fsusblog.local-production.benchmark-build-ready.v1'
    || marker.status !== 'success'
    || marker.physicalBundleId !== 'backend-tests'
    || marker.schedulerRunId !== runId)
    {
        throw new Error(`backend production benchmark readiness marker is not bound to run ${runId}`);
    }
    const schedulerGrant = readSchedulerGrant();
    if (!schedulerGrant)
    {
        throw new Error('backend production benchmark barrier cannot read the outer scheduler grant');
    }
    return schedulerGrant;
}

export function resolveBackendShardParallelism({
    env = process.env,
    availableCpu = os.availableParallelism(),
    availableMemoryGiB = os.freemem() / (1024 ** 3),
    totalMemoryGiB = os.totalmem() / (1024 ** 3)
} = {})
{
    const detectedCpu = positiveInteger(availableCpu, null);
    if (!detectedCpu || detectedCpu < 2)
    {
        throw new Error('backend production requires at least two available CPU units');
    }
    const configuredCpuBudget = env.FSUSBLOG_BACKEND_CPU_BUDGET ?? env.FSUSBLOG_BUNDLE_CPU_BUDGET;
    const cpuBudget = configuredPositiveInteger(configuredCpuBudget, 'backend production CPU budget') ?? detectedCpu;
    if (cpuBudget > detectedCpu)
    {
        throw new Error(`backend production CPU budget ${cpuBudget} exceeds ${detectedCpu} available CPU units`);
    }
    if (cpuBudget < 2)
    {
        throw new Error('backend production requires a CPU budget of at least two units');
    }
    const detectedMemoryGiB = positiveNumber(availableMemoryGiB, null);
    if (!detectedMemoryGiB)
    {
        throw new Error('backend production requires positive available memory');
    }
    const detectedTotalMemoryGiB = positiveNumber(totalMemoryGiB, null);
    if (!detectedTotalMemoryGiB)
    {
        throw new Error('backend production requires positive total memory');
    }
    const configuredMemoryGiB = env.FSUSBLOG_STEP_MEMORY_GIB ?? env.FSUSBLOG_BUNDLE_MEMORY_GIB;
    if (configuredMemoryGiB !== undefined
    && !positiveNumber(configuredMemoryGiB, null))
    {
        throw new Error('backend production memory budget must be a positive number of GiB');
    }
    const schedulerManaged = configuredMemoryGiB !== undefined;
    const memoryGiB = positiveNumber(configuredMemoryGiB, detectedMemoryGiB);
    if (!memoryGiB)
    {
        throw new Error('backend production requires a positive memory budget');
    }
    const machineMemoryGiBPerCpu = detectedTotalMemoryGiB / detectedCpu;
    const memoryShardLimit = schedulerManaged
        ? Math.floor(memoryGiB / backendTopologyDefaults.memoryGiBPerTesthost)
        : Math.max(1, Math.floor(memoryGiB / machineMemoryGiBPerCpu));
    if (memoryShardLimit < 2)
    {
        throw new Error(
            `backend production memory budget supports ${memoryShardLimit} machine-derived shard unit; at least two are required`
        );
    }
    const derivedProcessCount = Math.min(
        cpuBudget,
        memoryShardLimit,
        backendTopologyDefaults.maxTesthosts,
        Math.max(2, Math.floor(Math.sqrt(cpuBudget)))
    );
    const configuredProcessCount = configuredPositiveInteger(
        env.FSUSBLOG_BACKEND_PRODUCTION_SHARDS,
        'backend production diagnostic process override'
    );
    const maxConcurrentProcesses = configuredProcessCount ?? derivedProcessCount;
    if (maxConcurrentProcesses < 2)
    {
        throw new Error('backend production requires at least two concurrent processes');
    }
    if (maxConcurrentProcesses > cpuBudget)
    {
        throw new Error(`backend production process count ${maxConcurrentProcesses} exceeds CPU budget ${cpuBudget}`);
    }
    if (maxConcurrentProcesses > memoryShardLimit)
    {
        throw new Error(
            `backend production process count ${maxConcurrentProcesses} exceeds memory budget limit ${memoryShardLimit}`
        );
    }
    const configuredProcessors = configuredPositiveInteger(
        env.FSUSBLOG_BACKEND_SHARD_PROCESSORS,
        'backend production diagnostic processor override'
    );
    const processorsByProcess = configuredProcessors
        ? Array.from({ length: maxConcurrentProcesses }, () => configuredProcessors)
        : allocateBackendTopologyProcessors(cpuBudget, maxConcurrentProcesses);
    const allocatedCpuUnits = processorsByProcess.reduce((total, processors) => total + processors, 0);
    if (allocatedCpuUnits !== cpuBudget)
    {
        throw new Error(
            `backend production allocation [${processorsByProcess.join(',')}] must exactly consume CPU budget ${cpuBudget}`
        );
    }
    const memoryGiBByProcess = Array.from(
        { length: maxConcurrentProcesses },
        () => memoryGiB / maxConcurrentProcesses
    );
    if (memoryGiBByProcess.some((value) => value + 1e-9 < backendTopologyDefaults.memoryGiBPerTesthost))
    {
        throw new Error(
            `backend production process allocation requires at least ${backendTopologyDefaults.memoryGiBPerTesthost} GiB per testhost`
        );
    }
    return {
        availableCpu: detectedCpu,
        availableMemoryGiB: detectedMemoryGiB,
        totalMemoryGiB: detectedTotalMemoryGiB,
        schedulerManaged,
        cpuBudget,
        memoryGiB,
        machineMemoryGiBPerCpu,
        memoryShardLimit,
        maxConcurrentProcesses,
        processorsByProcess,
        memoryGiBByProcess,
        allocatedCpuUnits,
        derivation: {
            source: configuredProcessCount ? 'diagnostic-override' : 'machine-derived',
            formula: schedulerManaged
                ? 'min(max(2,floor(sqrt(cpuBudget))),cpuBudget,floor(memoryGiB/1GiB),12)'
                : 'min(max(2,floor(sqrt(cpuBudget))),cpuBudget,floor(liveMemoryGiB/(totalMemoryGiB/availableCpu)),12)',
            derivedProcessCount,
            configuredProcessCount,
            cpuAllocationFormula: configuredProcessors
                ? 'diagnostic uniform processors per process; sum must equal cpuBudget'
                : 'floor(cpuBudget/processCount) plus one for the first cpuBudget%processCount processes',
            configuredProcessorsPerProcess: configuredProcessors,
            memoryAllocationFormula: 'memoryGiB/processCount with a 1 GiB per-testhost floor'
        }
    };
}

function testClassForMethod(method)
{
    const separator = method.lastIndexOf('.');
    return separator > 0 ? method.slice(0, separator) : method;
}

export function deriveClassStartupPenalty(testNames, estimatedCases = testNames?.length)
{
    if (!Array.isArray(testNames) || testNames.length === 0
    || !Number.isInteger(estimatedCases) || estimatedCases < testNames.length)
    {
        throw new Error('backend class startup penalty requires discovered tests and a valid case estimate');
    }
    const classCount = new Set(testNames.map(normalizeListedTestName).map(testClassForMethod)).size;
    if (classCount === 0)
    {
        throw new Error('backend class startup penalty requires discovered test classes');
    }
    return Math.max(1, Math.ceil(estimatedCases / Math.sqrt(classCount)));
}

export function deriveColdApplicationStartupPenalty(productionTestCaseCount)
{
    if (!Number.isInteger(productionTestCaseCount) || productionTestCaseCount < 1)
    {
        throw new Error('backend cold application startup penalty requires a positive production case count');
    }
    return Math.ceil(Math.sqrt(productionTestCaseCount));
}

export function deriveBackendPartitionCount(
    testNames,
    {
        maxConcurrentProcesses,
        potentialConcurrentProcesses = null,
        affinityGroups = [],
        partitionMultiplier = backendTopologyDefaults.partitionMultiplier
    } = {}
)
{
    if (!Number.isInteger(maxConcurrentProcesses) || maxConcurrentProcesses < 2)
    {
        throw new Error('backend production partitioning requires at least two concurrent processes');
    }
    const affinityClasses = new Set(affinityGroups.flatMap(({ testNames: names = [] }) => (
        names.map(normalizeListedTestName).map(testClassForMethod)
    )));
    const regularClasses = new Set(testNames
        .map(normalizeListedTestName)
        .filter((method) => !affinityClasses.has(testClassForMethod(method)))
        .map(testClassForMethod));
    const affinityParents = affinityGroups.map((_, index) => index);
    const findAffinity = (index) => affinityParents[index] === index
        ? index
        : (affinityParents[index] = findAffinity(affinityParents[index]));
    const affinityOwnerByClass = new Map();
    affinityGroups.forEach(({ testNames: names = [] }, index) =>
    {
        for (const testClass of new Set(names.map(normalizeListedTestName).map(testClassForMethod)))
        {
            const owner = affinityOwnerByClass.get(testClass);
            if (owner === undefined)
            {
                affinityOwnerByClass.set(testClass, index);
            }
            else
            {
                const left = findAffinity(owner);
                const right = findAffinity(index);
                if (left !== right)
                {
                    affinityParents[Math.max(left, right)] = Math.min(left, right);
                }
            }
        }
    });
    const affinityUnitCount = new Set(affinityGroups.map((_, index) => findAffinity(index))).size;
    const planningUnitCount = regularClasses.size + affinityUnitCount;
    if (planningUnitCount <= maxConcurrentProcesses)
    {
        throw new Error(
            `backend production rolling execution requires more than ${maxConcurrentProcesses} indivisible class/affinity units; discovered ${planningUnitCount}`
        );
    }
    if (potentialConcurrentProcesses !== null
    && (!Number.isInteger(potentialConcurrentProcesses) || potentialConcurrentProcesses < maxConcurrentProcesses))
    {
        throw new Error('backend production potential concurrency must be an integer no smaller than initial concurrency');
    }
    const normalizedPartitionMultiplier = positiveNumber(partitionMultiplier, null);
    if (!normalizedPartitionMultiplier || normalizedPartitionMultiplier < 1)
    {
        throw new Error('backend production partition multiplier must be a number of at least one');
    }
    const partitionCount = Math.min(
        planningUnitCount,
        potentialConcurrentProcesses
      ?? Math.max(maxConcurrentProcesses, Math.ceil(maxConcurrentProcesses * normalizedPartitionMultiplier))
    );
    return {
        partitionCount,
        planningUnitCount,
        testClassCount: regularClasses.size,
        affinityUnitCount,
        formula: potentialConcurrentProcesses === null
            ? 'min(planningUnitCount,max(processCount,ceil(processCount*partitionMultiplier)))'
            : 'min(planningUnitCount,potentialConcurrentProcesses)'
    };
}

export function normalizeListedTestName(value)
{
    const normalized = String(value ?? '').trim();
    const argumentIndex = normalized.indexOf('(');
    return (argumentIndex >= 0 ? normalized.slice(0, argumentIndex) : normalized).trim();
}

export function parseListedTests(stdout)
{
    const marker = 'The following Tests are available:';
    const output = String(stdout);
    const markerIndex = output.indexOf(marker);
    if (markerIndex < 0)
    {
        throw new Error('dotnet test --list-tests did not emit its test-list marker');
    }
    const listing = output.slice(markerIndex + marker.length);
    const platformFailure = listing.match(/Microsoft\.VisualStudio\.TestPlatform\.[\s\S]*?(?=\n\s*at |$)/u)?.[0]?.trim();
    if (platformFailure)
    {
        throw new Error(`backend production discovery testhost failed: ${platformFailure}`);
    }
    const testNames = listing
        .split(/\r?\n/u)
        .filter((line) => /^ {4}\S/u.test(line))
        .map((line) => line.trim());
    if (testNames.length === 0)
    {
        throw new Error('backend production test discovery returned no tests');
    }
    return testNames;
}

export function buildShardPlan(
    testNames,
    shardCount = 2,
    processorsByShard = Array.from({ length: shardCount }, () => 1),
    { affinityGroups = [], dependencyWeights = [], exclusiveAffinityGroups = [] } = {}
)
{
    if (!Number.isInteger(shardCount) || shardCount < 2)
    {
        throw new Error('backend production requires at least two shards');
    }
    if (!Array.isArray(processorsByShard)
    || processorsByShard.length !== shardCount
    || processorsByShard.some((processors) => !Number.isInteger(processors) || processors < 1))
    {
        throw new Error('backend production shard plan requires one positive processor allocation per shard');
    }
    const methodCounts = new Map();
    for (const testName of testNames)
    {
        const method = normalizeListedTestName(testName);
        if (!method)
        {
            throw new Error('backend production discovery contained an empty test method');
        }
        methodCounts.set(method, (methodCounts.get(method) ?? 0) + 1);
    }
    const methodsByShard = Array.from({ length: shardCount }, () => []);
    const plannedTestCaseCountsByShard = Array.from({ length: shardCount }, () => 0);
    const planningWeightsByShard = Array.from({ length: shardCount }, () => 0);
    const startupWeightsByShard = Array.from({ length: shardCount }, () => 0);
    if (!Array.isArray(dependencyWeights))
    {
        throw new Error('backend production shard plan dependencyWeights must be an array');
    }
    const dependencyAdditionalWeightsByMethod = new Map();
    const dependencyStartupWeightsByClass = new Map();
    const dependencyNames = new Set();
    const normalizedDependencyWeights = dependencyWeights.map(({
        name,
        testNames: dependencyTestNames,
        classStartupPenalty = 0
    }) =>
    {
        const normalizedName = String(name ?? '').trim();
        if (!normalizedName)
        {
            throw new Error('backend production dependency weight requires a name');
        }
        if (dependencyNames.has(normalizedName))
        {
            throw new Error(`backend production dependency weight repeats ${normalizedName}`);
        }
        dependencyNames.add(normalizedName);
        if (!Array.isArray(dependencyTestNames) || dependencyTestNames.length === 0)
        {
            throw new Error(`backend production dependency ${normalizedName} returned no tests`);
        }
        const dependencyMethodCounts = new Map();
        for (const testName of dependencyTestNames)
        {
            const method = normalizeListedTestName(testName);
            dependencyMethodCounts.set(method, (dependencyMethodCounts.get(method) ?? 0) + 1);
        }
        for (const [method, dependencyCaseCount] of dependencyMethodCounts)
        {
            const unionCaseCount = methodCounts.get(method);
            if (!unionCaseCount)
            {
                throw new Error(`backend production dependency ${normalizedName} contains a method outside the production union: ${method}`);
            }
            if (dependencyCaseCount > unionCaseCount)
            {
                throw new Error(
                    `backend production dependency ${normalizedName} case count exceeds the production union for ${method}: `
          + `union ${unionCaseCount}, dependency ${dependencyCaseCount}`
                );
            }
            dependencyAdditionalWeightsByMethod.set(
                method,
                (dependencyAdditionalWeightsByMethod.get(method) ?? 0) + dependencyCaseCount
            );
        }
        if (!Number.isInteger(classStartupPenalty) || classStartupPenalty < 0)
        {
            throw new Error(`backend production dependency ${normalizedName} has an invalid class startup penalty`);
        }
        const dependencyClasses = [...new Set([...dependencyMethodCounts.keys()].map(testClassForMethod))].sort();
        for (const testClass of dependencyClasses)
        {
            dependencyStartupWeightsByClass.set(
                testClass,
                (dependencyStartupWeightsByClass.get(testClass) ?? 0) + classStartupPenalty
            );
        }
        const testCaseCount = dependencyTestNames.length;
        return {
            name: normalizedName,
            methods: [...dependencyMethodCounts.keys()].sort(),
            methodCounts: dependencyMethodCounts,
            testClasses: dependencyClasses,
            testCaseCount,
            classStartupPenalty,
            classStartupPlanningWeight: classStartupPenalty * dependencyClasses.length,
            planningMultiplier: dependencyPlanningMultiplier,
            additionalPlanningWeight: testCaseCount,
            weightedPlanningWeight: testCaseCount * dependencyPlanningMultiplier
        + classStartupPenalty * dependencyClasses.length
        };
    });
    if (!Array.isArray(affinityGroups))
    {
        throw new Error('backend production shard plan affinityGroups must be an array');
    }
    if (!Array.isArray(exclusiveAffinityGroups))
    {
        throw new Error('backend production shard plan exclusiveAffinityGroups must be an array');
    }
    const exclusiveAffinityNames = new Set(exclusiveAffinityGroups.map((name) => String(name).trim()));
    const assignedAffinityMethods = new Set();
    const affinityNames = new Set();
    const declaredAffinityGroups = affinityGroups.map(({ name, testNames: affinityTestNames }) =>
    {
        const normalizedName = String(name ?? '').trim();
        if (!normalizedName)
        {
            throw new Error('backend production shard affinity requires a name');
        }
        if (affinityNames.has(normalizedName))
        {
            throw new Error(`backend production shard affinity repeats ${normalizedName}`);
        }
        affinityNames.add(normalizedName);
        if (!Array.isArray(affinityTestNames) || affinityTestNames.length === 0)
        {
            throw new Error(`backend production shard affinity ${normalizedName} returned no tests`);
        }
        const affinityMethodCounts = new Map();
        for (const testName of affinityTestNames)
        {
            const method = normalizeListedTestName(testName);
            affinityMethodCounts.set(method, (affinityMethodCounts.get(method) ?? 0) + 1);
        }
        const discoveredMethods = [...affinityMethodCounts.keys()].sort();
        for (const method of discoveredMethods)
        {
            if (!methodCounts.has(method))
            {
                throw new Error(`backend production shard affinity ${normalizedName} contains a method outside the production union: ${method}`);
            }
            if (affinityMethodCounts.get(method) !== methodCounts.get(method))
            {
                throw new Error(
                    `backend production shard affinity ${normalizedName} case count mismatch for ${method}: `
          + `union ${methodCounts.get(method)}, affinity ${affinityMethodCounts.get(method)}`
                );
            }
        }
        const testClasses = [...new Set(discoveredMethods.map(testClassForMethod))].sort();
        return { name: normalizedName, taggedTestNames: [...new Set(affinityTestNames)].sort(), testClasses };
    });
    const parents = declaredAffinityGroups.map((_, index) => index);
    const find = (index) => parents[index] === index ? index : (parents[index] = find(parents[index]));
    const union = (left, right) =>
    {
        const leftRoot = find(left);
        const rightRoot = find(right);
        if (leftRoot === rightRoot)
        {
            return;
        }
        const [first, second] = leftRoot < rightRoot ? [leftRoot, rightRoot] : [rightRoot, leftRoot];
        parents[second] = first;
    };
    const ownerByClass = new Map();
    declaredAffinityGroups.forEach((group, index) =>
    {
        for (const testClass of group.testClasses)
        {
            const owner = ownerByClass.get(testClass);
            if (owner === undefined)
            {
                ownerByClass.set(testClass, index);
            }
            else
            {
                union(owner, index);
            }
        }
    });
    const componentGroups = new Map();
    declaredAffinityGroups.forEach((group, index) =>
    {
        const rootIndex = find(index);
        const groups = componentGroups.get(rootIndex) ?? [];
        groups.push(group);
        componentGroups.set(rootIndex, groups);
    });
    const normalizedAffinityGroups = [...componentGroups.values()].map((groups) =>
    {
        const groupNames = groups.map((group) => group.name).sort();
        const testClasses = [...new Set(groups.flatMap((group) => group.testClasses))].sort();
        const methods = [...methodCounts.keys()]
            .filter((method) => testClasses.includes(testClassForMethod(method)))
            .sort();
        for (const method of methods)
        {
            assignedAffinityMethods.add(method);
        }
        const testCaseCount = methods.reduce((total, method) => total + methodCounts.get(method), 0);
        const affinityTaggedTestCaseCount = new Set(groups.flatMap((group) => group.taggedTestNames)).size;
        const dependencyAdditionalPlanningWeight = methods.reduce(
            (total, method) => total + (dependencyAdditionalWeightsByMethod.get(method) ?? 0),
            0
        );
        const dependencyStartupPlanningWeight = [...new Set(methods.map(testClassForMethod))]
            .reduce((total, testClass) => total + (dependencyStartupWeightsByClass.get(testClass) ?? 0), 0);
        return {
            name: groupNames.join('+'),
            groupNames,
            exclusive: groupNames.some((name) => exclusiveAffinityNames.has(name)),
            methods,
            testCaseCount,
            affinityTaggedTestCaseCount,
            startupWeight: testCaseCount,
            planningWeight: testCaseCount * 2 + dependencyAdditionalPlanningWeight + dependencyStartupPlanningWeight
        };
    }).sort((left, right) => left.name.localeCompare(right.name));
    const remainingMethods = [...methodCounts.keys()]
        .filter((method) => !assignedAffinityMethods.has(method));
    const methodsByTestClass = new Map();
    for (const method of remainingMethods)
    {
        const separator = method.lastIndexOf('.');
        const testClass = separator > 0 ? method.slice(0, separator) : method;
        const methods = methodsByTestClass.get(testClass) ?? [];
        methods.push(method);
        methodsByTestClass.set(testClass, methods);
    }
    const planningUnitCount = methodsByTestClass.size + normalizedAffinityGroups.length;
    if (planningUnitCount < shardCount)
    {
        throw new Error(
            `backend production cannot create ${shardCount} partitions from ${planningUnitCount} indivisible class/affinity units`
        );
    }
    const regularPlanningUnits = [...methodsByTestClass.entries()].map(([testClass, methods]) => ({
        key: `class:${testClass}`,
        methods: methods.sort(),
        testCaseCount: methods.reduce((total, method) => total + methodCounts.get(method), 0),
        startupWeight: dependencyStartupWeightsByClass.get(testClass) ?? 0,
        planningWeight: methods.reduce(
            (total, method) => total + methodCounts.get(method) + (dependencyAdditionalWeightsByMethod.get(method) ?? 0),
            0
        ) + (dependencyStartupWeightsByClass.get(testClass) ?? 0),
        affinity: null
    }));
    const planningUnits = [
        ...normalizedAffinityGroups.map((group) => ({
            key: `affinity:${group.name}`,
            methods: group.methods,
            testCaseCount: group.testCaseCount,
            startupWeight: group.startupWeight,
            planningWeight: group.planningWeight,
            affinity: group.name
        })),
        ...regularPlanningUnits
    ].sort((left, right) => right.planningWeight - left.planningWeight || left.key.localeCompare(right.key));
    const affinityAssignments = {};
    if (normalizedAffinityGroups.length > shardCount)
    {
        throw new Error(
            `backend production cannot reserve ${normalizedAffinityGroups.length} affinity components across ${shardCount} shards`
        );
    }
    const reservedAffinityShards = new Map(
        normalizedAffinityGroups.map((group, index) => [group.name, index])
    );
    const exclusiveAffinityShardIds = new Set(normalizedAffinityGroups
        .filter((group) => group.exclusive)
        .map((group) => reservedAffinityShards.get(group.name)));
    for (const unit of planningUnits)
    {
        let shardIndex = unit.affinity ? reservedAffinityShards.get(unit.affinity) : 0;
        if (!unit.affinity)
        {
            const regularShardIds = Array.from({ length: shardCount }, (_, index) => index)
                .filter((index) => !exclusiveAffinityShardIds.has(index));
            if (regularShardIds.length === 0)
            {
                throw new Error('backend production exclusive affinity shards leave no shard for regular tests');
            }
            shardIndex = regularShardIds[0];
            for (const candidate of regularShardIds.slice(1))
            {
                const candidateScaledLoad = planningWeightsByShard[candidate] * processorsByShard[shardIndex];
                const selectedScaledLoad = planningWeightsByShard[shardIndex] * processorsByShard[candidate];
                if (candidateScaledLoad < selectedScaledLoad)
                {
                    shardIndex = candidate;
                }
            }
        }
        methodsByShard[shardIndex].push(...unit.methods);
        plannedTestCaseCountsByShard[shardIndex] += unit.testCaseCount;
        planningWeightsByShard[shardIndex] += unit.planningWeight;
        startupWeightsByShard[shardIndex] += unit.startupWeight;
        if (unit.affinity)
        {
            const group = normalizedAffinityGroups.find(({ name }) => name === unit.affinity);
            for (const groupName of group.groupNames)
            {
                affinityAssignments[groupName] = {
                    shardId: shardIndex,
                    actualTestCaseCount: group.testCaseCount,
                    affinityTaggedTestCaseCount: group.affinityTaggedTestCaseCount,
                    startupWeight: group.startupWeight,
                    planningWeight: group.planningWeight
                };
            }
        }
    }
    for (const methods of methodsByShard)
    {
        methods.sort();
    }
    if (methodsByShard.some((methods) => methods.length === 0))
    {
        throw new Error('backend production shard plan contains an empty shard');
    }
    const shardByMethod = new Map(methodsByShard.flatMap((methods, shardId) => (
        methods.map((method) => [method, shardId])
    )));
    const dependencyWeightAssignments = Object.fromEntries(normalizedDependencyWeights.map((dependency) =>
    {
        const plannedTestMethodCountsByShard = Array.from({ length: shardCount }, () => 0);
        const plannedTestCaseCountsByShardForDependency = Array.from({ length: shardCount }, () => 0);
        for (const method of dependency.methods)
        {
            const shardId = shardByMethod.get(method);
            plannedTestMethodCountsByShard[shardId] += 1;
            plannedTestCaseCountsByShardForDependency[shardId] += dependency.methodCounts.get(method);
        }
        return [dependency.name, {
            actualTestMethodCount: dependency.methods.length,
            actualTestCaseCount: dependency.testCaseCount,
            actualTestClassCount: dependency.testClasses.length,
            classStartupPenalty: dependency.classStartupPenalty,
            classStartupPlanningWeight: dependency.classStartupPlanningWeight,
            planningMultiplier: dependency.planningMultiplier,
            additionalPlanningWeight: dependency.additionalPlanningWeight,
            weightedPlanningWeight: dependency.weightedPlanningWeight,
            plannedTestMethodCountsByShard,
            plannedTestCaseCountsByShard: plannedTestCaseCountsByShardForDependency,
            testMethods: dependency.methods
        }];
    }));
    return {
        testCaseCount: testNames.length,
        methodCounts,
        methodsByShard,
        plannedTestCaseCountsByShard,
        planningWeightsByShard,
        startupWeightsByShard,
        partitionUnitKind: 'test-class',
        affinityAssignments,
        dependencyWeightAssignments,
        partitionDigest: `sha256:${sha256(JSON.stringify(methodsByShard))}`
    };
}

export function validateCategoryMembership(plan, discoveries)
{
    const discoveredMethods = new Set(plan.methodCounts.keys());
    const membership = {};
    for (const category of projectedCategories)
    {
        const categoryTests = discoveries[category];
        if (!Array.isArray(categoryTests) || categoryTests.length === 0)
        {
            throw new Error(`backend production category ${category} returned no tests`);
        }
        const methods = [...new Set(categoryTests.map(normalizeListedTestName))].sort();
        for (const method of methods)
        {
            if (!discoveredMethods.has(method))
            {
                throw new Error(`backend production category ${category} contains a method outside the production union: ${method}`);
            }
        }
        membership[category] = methods;
    }
    return membership;
}

export function alignAuthoritativeDiscovery(testNames, records)
{
    if (!Array.isArray(testNames) || testNames.length === 0 || !Array.isArray(records) || records.length === 0)
    {
        throw new Error('backend authoritative discovery alignment requires test-list and VSTest records');
    }
    const listed = [...testNames].sort();
    const authoritative = records.map((record) => record?.displayName).sort();
    if (listed.some((name) => typeof name !== 'string' || !name)
    || authoritative.some((name) => typeof name !== 'string' || !name)
    || JSON.stringify(listed) !== JSON.stringify(authoritative))
    {
        throw new Error('backend VSTest trait discovery does not exactly match the production union test list');
    }
    return records;
}

function projectProductionBaseUnionRecords(records)
{
    if (!Array.isArray(records) || records.length === 0)
    {
        throw new Error('backend production union projection requires authoritative VSTest records');
    }
    const excludedCategories = new Set(['Integration', 'Performance']);
    const included = records.filter((record) => (
        !(record.traits?.Category ?? []).some((value) => excludedCategories.has(value))
    && !(record.traits?.Fixture ?? []).includes('LocalRedis')
    ));
    if (included.length === 0 || included.length === records.length)
    {
        throw new Error('backend production union trait projection must include tests and exclude Integration/Performance tests');
    }
    return included;
}

export function projectProductionPlatformPlan(records, runtimePlatform = process.platform)
{
    return projectBackendPlatformPlan(projectProductionBaseUnionRecords(records), runtimePlatform, {
        baseFilter: productionBaseFilter,
        lane: 'backend-production'
    });
}

export function projectProductionUnionRecords(records, runtimePlatform = process.platform)
{
    return selectBackendPlatformRecords(projectProductionBaseUnionRecords(records), runtimePlatform);
}

export function validateExactProductionUnion(testNames, recordGroups, { authoritativeRecords = null } = {})
{
    if (!Array.isArray(testNames) || testNames.length === 0
    || !Array.isArray(recordGroups) || recordGroups.length === 0
    || recordGroups.some((records) => !Array.isArray(records)))
    {
        throw new Error('backend production exact union requires discovery plus one or more TRX record groups');
    }
    const records = recordGroups.flat();
    const discoveredGovernance = testNames.filter((testName) => (
        normalizeListedTestName(testName) === governanceRequirementTest
    ));
    if (discoveredGovernance.length !== 1)
    {
        throw new Error(`backend production exact union requires exactly one ${governanceRequirementTest}; discovered ${discoveredGovernance.length}`);
    }
    if (authoritativeRecords !== null)
    {
        if (!Array.isArray(authoritativeRecords) || authoritativeRecords.length !== testNames.length
      || authoritativeRecords.some((record) => typeof record?.id !== 'string' || !record.id
      || typeof record?.displayName !== 'string' || !record.displayName))
        {
            throw new Error('backend production exact union requires valid authoritative VSTest records');
        }
        const expectedIds = authoritativeRecords.map((record) => record.id).sort();
        const actualIds = records.map((record) => record?.testId).sort();
        if (actualIds.some((id) => typeof id !== 'string' || !id)
      || JSON.stringify(actualIds) !== JSON.stringify(expectedIds))
        {
            throw new Error('backend production TRX groups do not match their exact VSTest ids');
        }
    }
    else
    {
        const expected = [...testNames].sort();
        const actual = records.map((record) => record?.testName).sort();
        if (JSON.stringify(actual) !== JSON.stringify(expected))
        {
            throw new Error('backend production TRX groups do not match their exact filters');
        }
    }
    if (records.length !== testNames.length || records.some((record) => record?.outcome !== 'Passed'))
    {
        throw new Error('backend production exact union is incomplete or contains a non-passing result');
    }
    const actual = records.map((record) => record?.testName).sort();
    if (actual.some((testName) => typeof testName !== 'string' || !testName))
    {
        throw new Error('backend production TRX union contains an invalid result name');
    }
    if (records.filter((record) => normalizeListedTestName(record.testName) === governanceRequirementTest).length !== 1)
    {
        throw new Error('backend production requirement/evidence governance must execute exactly once inside the canonical union');
    }
    if (authoritativeRecords === null)
    {
        const expected = [...testNames].sort();
        if (JSON.stringify(actual) !== JSON.stringify(expected))
        {
            throw new Error('backend production TRX union does not match authoritative discovery exact-once');
        }
    }
    return {
        executedTestCaseCount: records.length,
        executedMethodCount: new Set(actual.map(normalizeListedTestName)).size,
        exactOnce: true,
        allPassed: true
    };
}

export function buildPostgresCollectionPlanningWeights(testNames, manifest, {
    excludedTestNames = [],
    manifestExcludedClasses = [],
    repositoryRoot = root,
    readFile = (file) => fs.readFileSync(file, 'utf8')
} = {})
{
    if (manifest?.schema !== 'fsusblog.postgres-test-collections.v1'
    || !Array.isArray(manifest.collections) || manifest.collections.length !== 2)
    {
        throw new Error('backend PostgreSQL collection affinity requires the authoritative v1 two-collection manifest');
    }
    const namesByClass = new Map();
    for (const testName of testNames)
    {
        const method = normalizeListedTestName(testName);
        const testClass = testClassForMethod(method);
        const names = namesByClass.get(testClass) ?? [];
        names.push(testName);
        namesByClass.set(testClass, names);
    }
    const assignedClasses = new Set();
    const allowedManifestExcludedClasses = new Set(manifestExcludedClasses);
    if (allowedManifestExcludedClasses.size !== manifestExcludedClasses.length
    || [...allowedManifestExcludedClasses].some((className) => typeof className !== 'string' || !className))
    {
        throw new Error('backend PostgreSQL collection manifest-excluded classes must be unique non-empty names');
    }
    const excludedNamesByClass = new Map();
    for (const testName of excludedTestNames)
    {
        const testClass = testClassForMethod(normalizeListedTestName(testName));
        const names = excludedNamesByClass.get(testClass) ?? [];
        names.push(testName);
        excludedNamesByClass.set(testClass, names);
    }
    const allDiscoveredClasses = new Set([...namesByClass.keys(), ...excludedNamesByClass.keys()]);
    const collectionIds = new Set();
    return manifest.collections.map((collection) =>
    {
        const id = String(collection?.id ?? '').trim();
        if (!/^SchemaMigrationPostgresCollection[AB]$/u.test(id) || collectionIds.has(id))
        {
            throw new Error(`backend PostgreSQL collection manifest has an invalid or repeated id: ${id || '<missing>'}`);
        }
        collectionIds.add(id);
        if (!Array.isArray(collection.tests) || collection.tests.length === 0)
        {
            throw new Error(`backend PostgreSQL collection ${id} has no declared test classes`);
        }
        const projectedNames = [];
        const projectedClasses = [];
        let excludedTestCaseCount = 0;
        let hasManifestExcludedClass = false;
        for (const entry of collection.tests)
        {
            const manifestPath = String(entry?.path ?? '').replaceAll('\\', '/');
            const className = String(entry?.class ?? '').trim();
            readPostgresManifestClassSource({ path: manifestPath, class: className }, {
                repositoryRoot,
                readFile,
                errorPrefix: `backend PostgreSQL collection ${id}`
            });
            const matchingClasses = [...allDiscoveredClasses].filter((testClass) => testClass.split('.').at(-1) === className);
            if (matchingClasses.length === 0 && allowedManifestExcludedClasses.has(className))
            {
                hasManifestExcludedClass = true;
                continue;
            }
            if (matchingClasses.length !== 1)
            {
                throw new Error(
                    `backend PostgreSQL collection ${id} class ${className} must match exactly one authoritative VSTest class; matched ${matchingClasses.length}`
                );
            }
            const fullyQualifiedClass = matchingClasses[0];
            if (assignedClasses.has(fullyQualifiedClass))
            {
                throw new Error(`backend PostgreSQL test class belongs to multiple collections: ${fullyQualifiedClass}`);
            }
            assignedClasses.add(fullyQualifiedClass);
            const classTests = namesByClass.get(fullyQualifiedClass);
            if (!Array.isArray(classTests) || classTests.length === 0)
            {
                if (excludedNamesByClass.has(fullyQualifiedClass))
                {
                    excludedTestCaseCount += excludedNamesByClass.get(fullyQualifiedClass).length;
                    continue;
                }
                throw new Error(`backend PostgreSQL collection ${id} class is missing from the production union: ${fullyQualifiedClass}`);
            }
            projectedClasses.push(fullyQualifiedClass);
            projectedNames.push(...classTests);
        }
        if (projectedNames.length === 0)
        {
            throw new Error(`backend PostgreSQL collection ${id} projected no production tests`);
        }
        if (hasManifestExcludedClass)
        {
            excludedTestCaseCount = collection.estimatedFacts - projectedNames.length;
            if (excludedTestCaseCount < 1)
            {
                throw new Error(`backend PostgreSQL collection ${id} has no capacity for its class-wide excluded tests`);
            }
        }
        if (!Number.isInteger(collection.estimatedFacts)
      || collection.estimatedFacts !== projectedNames.length + excludedTestCaseCount)
        {
            throw new Error(
                `backend PostgreSQL collection ${id} estimatedFacts does not match authoritative VSTest cases: `
        + `manifest=${collection.estimatedFacts ?? '<missing>'} discovered=${projectedNames.length + excludedTestCaseCount}`
            );
        }
        return {
            name: `PostgresCollection=${id}`,
            source: 'tests/backend/Fixtures/postgres-test-collections.json',
            collectionId: id,
            estimatedFacts: collection.estimatedFacts,
            excludedTestCaseCount,
            testClasses: projectedClasses.sort(),
            testNames: projectedNames.sort()
        };
    });
}

export function buildPostgresAffinityGroups(postgresGroups, maximumGroupCount)
{
    if (!Array.isArray(postgresGroups) || postgresGroups.length === 0)
    {
        throw new Error('backend PostgreSQL affinity planning requires collection groups');
    }
    if (!Number.isInteger(maximumGroupCount)
    || maximumGroupCount < postgresGroups.length)
    {
        throw new Error('backend PostgreSQL affinity maximum cannot be smaller than its collection count');
    }
    const classUnitsByCollection = postgresGroups.map((group) =>
    {
        const byClass = new Map();
        for (const testName of group.testNames)
        {
            const method = normalizeListedTestName(testName);
            const separator = method.lastIndexOf('.');
            if (separator <= 0)
            {
                throw new Error(`backend PostgreSQL test has no declaring class: ${testName}`);
            }
            const className = method.slice(0, separator);
            const names = byClass.get(className) ?? [];
            names.push(testName);
            byClass.set(className, names);
        }
        return {
            name: group.name,
            units: [...byClass.entries()].map(([className, testNames]) => ({ className, testNames }))
        };
    });
    const collectionCaseCounts = classUnitsByCollection.map((group) => (
        group.units.reduce((sum, unit) => sum + unit.testNames.length, 0)
    ));
    const baselinePressure = Math.min(...collectionCaseCounts);
    const availableClassCount = classUnitsByCollection.reduce((sum, group) => sum + group.units.length, 0);
    const boundedMaximum = Math.min(maximumGroupCount, availableClassCount);
    const partitionCounts = Array.from({ length: postgresGroups.length }, () => 1);
    while (partitionCounts.reduce((sum, count) => sum + count, 0) < boundedMaximum)
    {
        let selected = -1;
        let selectedPressure = -1;
        for (let index = 0; index < classUnitsByCollection.length; index += 1)
        {
            if (partitionCounts[index] >= classUnitsByCollection[index].units.length)
            {
                continue;
            }
            const pressure = collectionCaseCounts[index] / partitionCounts[index];
            if (pressure > selectedPressure)
            {
                selected = index;
                selectedPressure = pressure;
            }
        }
        // The smallest declared collection is the observed one-testhost baseline.
        // Split only collections whose projected pressure still exceeds it. The
        // scheduler/machine potential is an upper bound, not a command to create
        // needless PostgreSQL containers and coverage collectors.
        if (selected < 0 || selectedPressure <= baselinePressure)
        {
            break;
        }
        partitionCounts[selected] += 1;
    }
    return classUnitsByCollection.flatMap((collection, collectionIndex) =>
    {
        const count = partitionCounts[collectionIndex];
        const bins = Array.from({ length: count }, (_, index) => ({ index, weight: 0, testNames: [] }));
        const units = [...collection.units].sort((left, right) => (
            right.testNames.length - left.testNames.length
      || left.className.localeCompare(right.className)
        ));
        for (const unit of units)
        {
            bins.sort((left, right) => left.weight - right.weight || left.index - right.index);
            bins[0].testNames.push(...unit.testNames);
            bins[0].weight += unit.testNames.length;
        }
        return bins.sort((left, right) => left.index - right.index).map((bin) => ({
            name: count === 1 ? collection.name : `${collection.name}:part-${bin.index + 1}-of-${count}`,
            testNames: bin.testNames
        }));
    });
}

export function readManifestClassWideProductionExclusions(manifest, {
    repositoryRoot = root,
    readFile = (file) => fs.readFileSync(file, 'utf8')
} = {})
{
    if (manifest?.schema !== 'fsusblog.postgres-test-collections.v1'
    || !Array.isArray(manifest.collections))
    {
        throw new Error('backend PostgreSQL class-wide exclusion scan requires the authoritative manifest');
    }
    const excluded = new Set();
    for (const entry of manifest.collections.flatMap((collection) => collection.tests ?? []))
    {
        const { classMatch, className, source } = readPostgresManifestClassSource(entry, {
            repositoryRoot,
            readFile,
            errorPrefix: 'backend PostgreSQL class-wide exclusion scan'
        });
        const declarationPrefix = source.slice(Math.max(0, classMatch.index - 4096), classMatch.index);
        if (/\[Trait\(\s*"Category"\s*,\s*"(?:Integration|Performance)"\s*\)\]/u.test(declarationPrefix))
        {
            excluded.add(className);
        }
    }
    return [...excluded].sort();
}

function readPostgresManifestClassSource(entry, {
    repositoryRoot,
    readFile,
    errorPrefix
})
{
    const relativePath = String(entry?.path ?? '').replaceAll('\\', '/');
    const className = String(entry?.class ?? '').trim();
    const invalidPath = !relativePath
    || relativePath.startsWith('/')
    || /^[A-Za-z]:\//u.test(relativePath)
    || relativePath.split('/').includes('..')
    || !relativePath.endsWith('.cs');
    if (invalidPath || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(className))
    {
        throw new Error(`${errorPrefix} has an invalid class declaration`);
    }
    const sourcePath = path.resolve(repositoryRoot, 'tests/backend', relativePath);
    let source;
    try
    {
        source = readFile(sourcePath);
    }
    catch (error)
    {
        throw new Error(`${errorPrefix} source file is missing: ${relativePath}`, { cause: error });
    }
    if (typeof source !== 'string')
    {
        throw new Error(`${errorPrefix} source file is missing: ${relativePath}`);
    }
    const classMatch = findCSharpClassDeclaration(source, className);
    if (!classMatch)
    {
        throw new Error(`${errorPrefix} source ${relativePath} does not declare class ${className}`);
    }
    return { classMatch, className, source };
}

export function aggregateCategoryDiscoveryFailures(categoryDiscoveryRuns)
{
    const failures = categoryDiscoveryRuns
        .filter(({ result }) => discoveryResultFailed(result));
    if (failures.length === 0)
    {
        return null;
    }
    return new AggregateError(
        failures.map(({ category, result }) => new Error(
            `${category}: ${discoveryFailureDetail(result)}`
        )),
        `backend production category discovery failed in ${failures.length} independent branches: ${failures.map(({ category }) => category).join(', ')}`
    );
}

export function aggregateProjectionDiscoveryFailures(projectionDiscoveryRuns)
{
    const failures = projectionDiscoveryRuns
        .filter(({ result }) => discoveryResultFailed(result));
    if (failures.length === 0)
    {
        return null;
    }
    return new AggregateError(
        failures.map(({ projection, result }) => new Error(
            `${projection}: ${discoveryFailureDetail(result)}`
        )),
        `backend production projection discovery failed in ${failures.length} independent branches: ${failures.map(({ projection }) => projection).join(', ')}`
    );
}

function discoveryResultFailed(result)
{
    return Boolean(result?.error || result?.signal || result?.code !== 0);
}

function discoveryFailureDetail(result)
{
    if (result?.error)
    {
        return result.error instanceof Error ? result.error.message : String(result.error);
    }
    return result?.stderr?.trim() || result?.signal || `exit ${result?.code}`;
}

export function aggregateProductionDiscoveryFailures({
    discovery,
    categoryDiscoveryRuns,
    affinityDiscoveryRuns,
    dependencyDiscoveryRuns
})
{
    const branches = [
        { projection: 'production-union', result: discovery },
        ...categoryDiscoveryRuns.map(({ category, result }) => ({ projection: `Category=${category}`, result })),
        ...affinityDiscoveryRuns.map(({ affinity, result }) => ({ projection: `ShardAffinity=${affinity}`, result })),
        ...dependencyDiscoveryRuns.map(({ dependency, result }) => ({ projection: `Dependency=${dependency}`, result }))
    ];
    const failures = branches.filter(({ result }) => discoveryResultFailed(result));
    if (failures.length === 0)
    {
        return null;
    }
    return new AggregateError(failures.map(({ projection, result }) => (
        new Error(`${projection}: ${discoveryFailureDetail(result)}`)
    )), `backend production discovery failed in ${failures.length} independent branches: ${failures.map(({ projection }) => projection).join(', ')}`);
}

export function backendDiscoveryEnvironment(env = process.env, {
    processSlot,
    maxParallel,
    cpuBudget,
    memoryGiB
} = {})
{
    if (!Number.isInteger(processSlot) || processSlot < 0
    || !Number.isInteger(maxParallel) || maxParallel < 1 || processSlot >= maxParallel
    || !Number.isInteger(cpuBudget) || cpuBudget < maxParallel
    || !positiveNumber(memoryGiB, null))
    {
        throw new Error('backend production discovery requires a valid resource slot and admitted grant');
    }
    const branchCpuUnits = Math.floor(cpuBudget / maxParallel) + (processSlot < cpuBudget % maxParallel ? 1 : 0);
    const branchMemoryGiB = memoryGiB / maxParallel;
    const dockerLimits = dockerLimitEnvironment(branchCpuUnits, branchMemoryGiB, env);
    return {
        ...env,
        DOTNET_PROCESSOR_COUNT: '1',
        FSUSBLOG_BACKEND_CPU_BUDGET: String(branchCpuUnits),
        FSUSBLOG_STEP_CPU_BUDGET: String(branchCpuUnits),
        FSUSBLOG_STEP_MEMORY_GIB: String(branchMemoryGiB),
        FSUSBLOG_BUNDLE_CPU_UNITS: String(branchCpuUnits),
        FSUSBLOG_BUNDLE_CPU_BUDGET: String(branchCpuUnits),
        FSUSBLOG_BUNDLE_MEMORY_GIB: String(branchMemoryGiB),
        ...dockerLimits
    };
}

export function backendPartitionEnvironment(env, { processors, memoryGiB, namespace, tempDirectory = null })
{
    if (!Number.isInteger(processors) || processors < 1)
    {
        throw new Error('backend production partition processors must be a positive integer');
    }
    if (!positiveNumber(memoryGiB, null))
    {
        throw new Error('backend production partition memory must be a positive number of GiB');
    }
    if (tempDirectory !== null && !path.isAbsolute(tempDirectory))
    {
        throw new Error('backend production partition temp directory must be absolute');
    }
    return {
        ...env,
        LC_ALL: env.LC_ALL ?? 'C.UTF-8',
        LANG: env.LANG ?? 'C.UTF-8',
        LC_MESSAGES: env.LC_MESSAGES ?? 'C.UTF-8',
        FSUSBLOG_REPO_ROOT: root,
        DOTNET_PROCESSOR_COUNT: String(processors),
        FSUSBLOG_BACKEND_CPU_BUDGET: String(processors),
        FSUSBLOG_STEP_CPU_BUDGET: String(processors),
        FSUSBLOG_STEP_MEMORY_GIB: String(memoryGiB),
        FSUSBLOG_BUNDLE_CPU_UNITS: String(processors),
        FSUSBLOG_BUNDLE_CPU_BUDGET: String(processors),
        FSUSBLOG_BUNDLE_MEMORY_GIB: String(memoryGiB),
        ...dockerLimitEnvironment(processors, memoryGiB, env),
        FSUSBLOG_BACKEND_DB_NAMESPACE: namespace,
        ...(tempDirectory === null ? {} : {
      TMPDIR: tempDirectory,
      TMP: tempDirectory,
      TEMP: tempDirectory
    })
    };
}

function dockerLimitEnvironment(cpuUnits, memoryGiB, parentEnvironment = process.env)
{
    const limits = resolveCgroupLimits({ cpuUnits, memoryGiB }, {
        cpuUnits: os.availableParallelism?.() ?? os.cpus().length,
        memoryGiB: os.totalmem() / (1024 ** 3)
    });
    const parentCpu = Number(parentEnvironment.FSUSBLOG_STEP_CPU_BUDGET);
    const parentMemoryGiB = Number(parentEnvironment.FSUSBLOG_STEP_MEMORY_GIB);
    const parentMemoryHigh = Number(parentEnvironment.FSUSBLOG_DOCKER_MEMORY_HIGH_BYTES);
    const parentMemoryMax = Number(parentEnvironment.FSUSBLOG_DOCKER_MEMORY_MAX_BYTES);
    const parentPidsMax = Number(parentEnvironment.FSUSBLOG_DOCKER_PIDS_MAX);
    const inheritedEnvelope = [parentCpu, parentMemoryGiB, parentMemoryHigh, parentMemoryMax, parentPidsMax]
        .every((value) => Number.isFinite(value) && value > 0);
    const memoryMaxBytes = inheritedEnvelope
        ? Math.max(limits.memoryHighBytes, Math.round(
        limits.memoryHighBytes + Math.max(0, parentMemoryMax - parentMemoryHigh) * memoryGiB / parentMemoryGiB))
        : limits.memoryMaxBytes;
    const pidsMax = inheritedEnvelope
        ? Math.max(1, Math.round(parentPidsMax * cpuUnits / parentCpu))
        : limits.pidsMax;
    return {
        FSUSBLOG_DOCKER_CPU_UNITS: String(cpuUnits),
        FSUSBLOG_DOCKER_MEMORY_HIGH_BYTES: String(limits.memoryHighBytes),
        FSUSBLOG_DOCKER_MEMORY_MAX_BYTES: String(memoryMaxBytes),
        FSUSBLOG_DOCKER_PIDS_MAX: String(pidsMax)
    };
}

export function resolveBackendTempRoot({ repositoryTempRoot, env = process.env } = {})
{
    const candidates = [
        env.FSUSBLOG_BACKEND_TEMP_ROOT,
    process.platform === 'linux' ? '/dev/shm' : null,
    os.tmpdir(),
    repositoryTempRoot
    ].filter((value) => typeof value === 'string' && value.trim());
    const viable = [];
    for (const candidate of new Set(candidates.map((value) => path.resolve(value))))
    {
        try
        {
            fs.mkdirSync(candidate, { recursive: true });
            fs.accessSync(candidate, fs.constants.W_OK | fs.constants.X_OK);
            const stats = fs.statfsSync(candidate);
            viable.push({ candidate, availableBytes: Number(stats.bavail) * Number(stats.bsize) });
        }
        catch
        {
            // Candidate selection is best-effort; the repository path remains the
            // final portable fallback and will surface its own I/O error if unusable.
        }
    }
    if (viable.length === 0)
    {
        throw new Error('backend production found no writable temporary filesystem');
    }
    return viable.sort((left, right) => right.availableBytes - left.availableBytes)[0].candidate;
}

export async function runAuthoritativeProductionDiscovery(runDiscovery)
{
    if (typeof runDiscovery !== 'function')
    {
        throw new TypeError('backend production discovery runner must be a function');
    }
    const startedAt = Date.now();
    let discovery;
    try
    {
        discovery = await runDiscovery(null, {
            processSlot: 0,
            maxParallel: 1,
            kind: 'union',
            name: null
        });
    }
    catch (error)
    {
        discovery = {
            code: null,
            signal: null,
            stdout: '',
            stderr: '',
            durationMs: Date.now() - startedAt,
            error
        };
    }
    return {
        discovery,
        categoryDiscoveryRuns: [],
        affinityDiscoveryRuns: [],
        dependencyDiscoveryRuns: [],
        durationMs: Date.now() - startedAt,
        maxParallel: 1,
        branchCount: 1
    };
}

function decodeXml(value)
{
    return String(value)
        .replaceAll('&quot;', '"')
        .replaceAll('&apos;', "'")
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
        .replaceAll('&amp;', '&')
        .replace(/&#x([0-9a-f]+);/giu, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
        .replace(/&#([0-9]+);/gu, (_, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)));
}

function trxAttribute(raw, name)
{
    const match = String(raw).match(new RegExp(`\\b${name}="([^"]*)"`, 'u'));
    return match ? decodeXml(match[1]) : '';
}

export function parseTrxRecords(xml)
{
    return parseBackendPlatformResultRows(xml).filter((record) => record.testName);
}

export function parseTrxTimingEvidence(xml)
{
    const timings = [...String(xml).matchAll(/<UnitTestResult\b([^>]*)>/gu)].map((match) => ({
        startedAtUnixMs: Date.parse(trxAttribute(match[1], 'startTime')),
        endedAtUnixMs: Date.parse(trxAttribute(match[1], 'endTime'))
    })).filter(({ startedAtUnixMs, endedAtUnixMs }) => (
        Number.isFinite(startedAtUnixMs)
    && Number.isFinite(endedAtUnixMs)
    && endedAtUnixMs >= startedAtUnixMs
    ));
    if (timings.length === 0)
    {
        return {
            status: 'unavailable',
            firstTestStartedAtUnixMs: null,
            lastTestEndedAtUnixMs: null,
            testExecutionSpanMs: null
        };
    }
    const firstTestStartedAtUnixMs = Math.min(...timings.map(({ startedAtUnixMs }) => startedAtUnixMs));
    const lastTestEndedAtUnixMs = Math.max(...timings.map(({ endedAtUnixMs }) => endedAtUnixMs));
    return {
        status: 'measured',
        firstTestStartedAtUnixMs,
        lastTestEndedAtUnixMs,
        testExecutionSpanMs: lastTestEndedAtUnixMs - firstTestStartedAtUnixMs
    };
}

export function parseTrxExecutionEvidence(xml)
{
    const text = String(xml);
    const summaries = [...text.matchAll(/<ResultSummary\b([^>]*)>/gu)];
    const counters = [...text.matchAll(/<Counters\b([^>]*)>/gu)];
    if (summaries.length !== 1 || trxAttribute(summaries[0][1], 'outcome') !== 'Completed'
    || counters.length !== 1)
    {
        throw new Error('backend production TRX must contain one completed result summary and one counter set');
    }
    const names = [
        'total', 'executed', 'passed', 'failed', 'error', 'timeout', 'aborted', 'inconclusive',
        'passedButRunAborted', 'notRunnable', 'notExecuted', 'disconnected', 'warning', 'completed',
        'inProgress', 'pending'
    ];
    const parsedCounters = Object.fromEntries(names.map((name) =>
    {
        const value = Number(trxAttribute(counters[0][1], name));
        if (!Number.isInteger(value) || value < 0)
        {
            throw new Error(`backend production TRX has an invalid ${name} counter`);
        }
        return [name, value];
    }));
    const records = parseTrxRecords(text);
    if (parsedCounters.total !== records.length
    || parsedCounters.executed !== records.length
    || parsedCounters.passed !== records.length
    || names.slice(3).some((name) => parsedCounters[name] !== 0))
    {
        throw new Error('backend production TRX counters do not prove every selected test executed and passed');
    }
    const ids = new Set(records.map((record) => record.testId));
    if (ids.size !== records.length || [...ids].some((id) => !id))
    {
        throw new Error('backend production TRX test IDs are empty or repeated');
    }
    return { records, counters: parsedCounters };
}

export function validateShardRecords(plan, recordsByShard)
{
    if (recordsByShard.length !== plan.methodsByShard.length)
    {
        throw new Error('backend production shard result count does not match the plan');
    }
    const actualCounts = new Map();
    let executed = 0;
    for (const [shardIndex, records] of recordsByShard.entries())
    {
        const allowedMethods = new Set(plan.methodsByShard[shardIndex]);
        for (const record of records)
        {
            if (record.outcome !== 'Passed')
            {
                throw new Error(`backend production shard ${shardIndex} contains ${record.outcome || 'unknown'} result: ${record.testName}`);
            }
            const method = normalizeListedTestName(record.testName);
            if (!allowedMethods.has(method))
            {
                throw new Error(`backend production shard ${shardIndex} executed an out-of-partition method: ${method}`);
            }
            actualCounts.set(method, (actualCounts.get(method) ?? 0) + 1);
            executed += 1;
        }
    }
    if (executed !== plan.testCaseCount)
    {
        throw new Error(`backend production shards executed ${executed} tests; discovery required ${plan.testCaseCount}`);
    }
    for (const [method, expected] of plan.methodCounts)
    {
        const actual = actualCounts.get(method) ?? 0;
        if (actual !== expected)
        {
            throw new Error(`backend production method count mismatch for ${method}: expected ${expected}, received ${actual}`);
        }
    }
    if ([...actualCounts.keys()].some((method) => !plan.methodCounts.has(method)))
    {
        throw new Error('backend production shards executed a method absent from discovery');
    }
    return { executedTestCaseCount: executed, executedMethodCount: actualCounts.size };
}

function validateSingleTesthostSummaryArtifacts(summary, trxFiles, repositoryRoot)
{
    if (summary.partitionCount !== 1
    || summary.maxConcurrentProcesses !== 1
    || summary.initialConcurrentProcesses !== 1
    || summary.peakConcurrentProcesses !== 1
    || summary.potentialConcurrentProcesses !== 1
    || summary.plannedConcurrentProcesses !== 1
    || summary.globalPotentialConcurrentProcesses !== 1)
    {
        throw new Error('backend production single-testhost summary must declare one process and one exact-union TRX partition');
    }
    const cpuBudget = positiveInteger(summary?.parallelism?.cpuBudget, null);
    const memoryGiB = positiveNumber(summary?.parallelism?.memoryGiB, null);
    if (!cpuBudget || !memoryGiB
    || JSON.stringify(summary.processorsByProcess) !== JSON.stringify([cpuBudget])
    || summary.allocatedCpuUnits !== cpuBudget
    || !Array.isArray(summary.memoryGiBByProcess)
    || summary.memoryGiBByProcess.length !== 1
    || Math.abs(summary.memoryGiBByProcess[0] - memoryGiB) > 1e-9
    || Math.abs(summary.allocatedMemoryGiB - memoryGiB) > 1e-9)
    {
        throw new Error('backend production single-testhost summary must consume its full admitted CPU and memory budget');
    }
    if (summary?.resourceExpansion?.dynamic !== false
    || summary.resourceExpansion.initialGrant?.cpuUnits !== cpuBudget
    || summary.resourceExpansion.potentialBudget?.cpuUnits !== cpuBudget)
    {
        throw new Error('backend production single-testhost summary has invalid fixed resource evidence');
    }
    if (!Array.isArray(summary.partitions) || summary.partitions.length !== 1
    || !Array.isArray(trxFiles) || trxFiles.length !== 1)
    {
        throw new Error('backend production single-testhost summary requires one exact-union TRX file');
    }
    const actualTrx = new Set(trxFiles.map((file) => path.relative(repositoryRoot, file).replaceAll(path.sep, '/')));
    const [main] = summary.partitions;
    if (main?.id !== 0 || main?.kind !== 'coverage-exact-union' || main?.processSlot !== 0
    || main.processors !== cpuBudget || Math.abs(main.memoryGiB - memoryGiB) > 1e-9
    || typeof main.coverageRoot !== 'string' || !main.coverageRoot)
    {
        throw new Error('backend production single-testhost summary has an invalid coverage exact-union partition');
    }
    if (!actualTrx.has(main.trx))
    {
        throw new Error('backend production single-testhost summary does not bind its executed TRX file');
    }
    if (summary?.execution?.exactOnce !== true || summary.execution.allPassed !== true
    || summary.execution.executedTestCaseCount !== summary?.discovery?.testCaseCount
    || summary.execution.executedTestCaseCount !== main.testCaseCount
    || summary.execution.governanceRequirementTestCaseCount !== 1)
    {
        throw new Error('backend production single-testhost summary does not prove a passing exact-once production union');
    }
    return {
        partitionCount: 1,
        maxConcurrentProcesses: 1,
        initialConcurrentProcesses: 1,
        peakConcurrentProcesses: 1,
        potentialConcurrentProcesses: 1,
        plannedConcurrentProcesses: 1,
        globalPotentialConcurrentProcesses: 1,
        processorsByProcess: [cpuBudget],
        allocatedCpuUnits: cpuBudget
    };
}

export function validateShardSummaryArtifacts(summary, trxFiles, { repositoryRoot = root } = {})
{
    if (summary?.status !== 'success')
    {
        throw new Error('backend production shard summary is not successful');
    }
    if (summary?.producer?.runId !== null && summary?.producer?.runId !== undefined)
    {
        const binding = summary?.buildBinding;
        if (binding?.runId !== summary.producer.runId
      || binding.sourceCommit !== summary.producer.sourceCommit
      || binding.sourceFingerprint !== summary.producer.sourceFingerprint
      || typeof binding.receipt !== 'string' || !binding.receipt
      || !/^sha256:[0-9a-f]{64}$/u.test(binding.receiptDigest ?? '')
      || typeof binding.testDll?.path !== 'string' || !binding.testDll.path
      || !/^sha256:[0-9a-f]{64}$/u.test(binding.testDll?.contentDigest ?? ''))
        {
            throw new Error('backend production shard summary is not bound to the canonical Release build receipt');
        }
    }
    if (summary?.executionMode === 'single-testhost-exact-union')
    {
        return validateSingleTesthostSummaryArtifacts(summary, trxFiles, repositoryRoot);
    }
    const partitionCount = positiveInteger(summary?.partitionCount, null);
    if (!partitionCount || partitionCount < 2)
    {
        throw new Error('backend production shard summary has an invalid partitionCount');
    }
    const preludePartitionCount = summary?.preludePartitionCount === undefined
        ? 0
        : positiveInteger(summary.preludePartitionCount, null);
    const postludePartitionCount = summary?.postludePartitionCount ?? 0;
    if (![0, 1].includes(preludePartitionCount)
    || postludePartitionCount !== 0
    || preludePartitionCount >= partitionCount
    || (summary?.rollingPartitionCount !== undefined
      && summary.rollingPartitionCount !== partitionCount - preludePartitionCount))
    {
        throw new Error('backend production shard summary must not declare a governance postlude partition');
    }
    const maxConcurrentProcesses = positiveInteger(summary?.maxConcurrentProcesses, null);
    if (!maxConcurrentProcesses || maxConcurrentProcesses < 2 || maxConcurrentProcesses > partitionCount)
    {
        throw new Error('backend production shard summary cannot have more concurrent processes than partitions');
    }
    const initialConcurrentProcesses = positiveInteger(summary?.initialConcurrentProcesses, null);
    const peakConcurrentProcesses = positiveInteger(summary?.peakConcurrentProcesses, null);
    const potentialConcurrentProcesses = positiveInteger(summary?.potentialConcurrentProcesses, null);
    const plannedConcurrentProcesses = positiveInteger(summary?.plannedConcurrentProcesses, null);
    const globalPotentialConcurrentProcesses = positiveInteger(summary?.globalPotentialConcurrentProcesses, null);
    if (!initialConcurrentProcesses || initialConcurrentProcesses > peakConcurrentProcesses
    || peakConcurrentProcesses !== maxConcurrentProcesses
    || peakConcurrentProcesses > potentialConcurrentProcesses
    || potentialConcurrentProcesses > partitionCount
    || plannedConcurrentProcesses !== potentialConcurrentProcesses
    || globalPotentialConcurrentProcesses < plannedConcurrentProcesses)
    {
        throw new Error('backend production shard summary has invalid initial, peak, or potential concurrency');
    }
    if (!Array.isArray(summary?.processorsByProcess)
    || summary.processorsByProcess.length !== maxConcurrentProcesses
    || summary.processorsByProcess.some((processors) => !positiveInteger(processors, null)))
    {
        throw new Error('backend production shard summary has an invalid processorsByProcess allocation');
    }
    const allocatedCpuUnits = summary.processorsByProcess
        .reduce((total, processors) => total + processors, 0);
    if (summary.allocatedCpuUnits !== allocatedCpuUnits)
    {
        throw new Error('backend production shard summary allocatedCpuUnits does not match processorsByProcess');
    }
    const dynamicExpansion = summary?.resourceExpansion?.dynamic === true;
    const potentialCpuBudget = positiveInteger(summary?.resourceExpansion?.potentialBudget?.cpuUnits, null);
    const potentialMemoryBudget = positiveNumber(summary?.resourceExpansion?.potentialBudget?.memoryGiB, null);
    const initialCpuGrant = positiveInteger(summary?.resourceExpansion?.initialGrant?.cpuUnits, null);
    const initialMemoryGrant = positiveNumber(summary?.resourceExpansion?.initialGrant?.memoryGiB, null);
    const observedCpuGrant = dynamicExpansion
        ? positiveInteger(summary?.resourceExpansion?.observedGrant?.cpuUnits, null)
        : initialCpuGrant;
    const observedMemoryGrant = dynamicExpansion
        ? positiveNumber(summary?.resourceExpansion?.observedGrant?.memoryGiB, null)
        : initialMemoryGrant;
    if (!potentialCpuBudget || !potentialMemoryBudget || !initialCpuGrant || !initialMemoryGrant)
    {
        throw new Error('backend production shard summary has invalid resource expansion grants');
    }
    if (!observedCpuGrant || !observedMemoryGrant
    || observedCpuGrant < initialCpuGrant
    || observedMemoryGrant + 1e-9 < initialMemoryGrant
    || observedCpuGrant > potentialCpuBudget
    || observedMemoryGrant > potentialMemoryBudget + 1e-9)
    {
        throw new Error('backend production shard summary has an invalid observed resource grant');
    }
    if (allocatedCpuUnits > potentialCpuBudget)
    {
        throw new Error('backend production shard summary CPU allocation exceeds its potential budget');
    }
    if (globalPotentialConcurrentProcesses > potentialCpuBudget)
    {
        throw new Error('backend production shard summary global potential exceeds its scheduler CPU budget');
    }
    const initialAllocatedCpuUnits = summary.processorsByProcess
        .slice(0, initialConcurrentProcesses)
        .reduce((total, processors) => total + processors, 0);
    if (initialAllocatedCpuUnits > initialCpuGrant)
    {
        throw new Error('backend production shard summary initial CPU allocation exceeds its initial grant');
    }
    if (!dynamicExpansion)
    {
        const declaredCpuBudget = positiveInteger(summary?.parallelism?.cpuBudget, null);
        if (!declaredCpuBudget)
        {
            throw new Error('backend production shard summary is missing a valid parallelism.cpuBudget');
        }
        if (allocatedCpuUnits !== declaredCpuBudget)
        {
            throw new Error('backend production shard summary processorsByProcess does not exactly consume its CPU budget');
        }
    }
    else if (Math.min(
        plannedConcurrentProcesses,
        observedCpuGrant,
        Math.floor(observedMemoryGrant / backendTopologyDefaults.memoryGiBPerTesthost)
    ) > initialConcurrentProcesses
    && peakConcurrentProcesses <= initialConcurrentProcesses)
    {
        throw new Error('backend production shard summary did not expand toward its observed scheduler grant');
    }
    const rollingCoveragePartitionCount = partitionCount - preludePartitionCount;
    if (dynamicExpansion && rollingCoveragePartitionCount < plannedConcurrentProcesses)
    {
        throw new Error('backend production scheduler planning must provide at least one coverage partition per planned process');
    }
    const initialTopology = summary?.planningForecast?.initialTopology;
    const potentialTopology = summary?.planningForecast?.potentialTopology;
    if (initialTopology !== undefined || potentialTopology !== undefined)
    {
        if (initialTopology?.schema !== 'fsusblog.backend-production-topology.v1'
      || potentialTopology?.schema !== 'fsusblog.backend-production-topology.v1'
      || initialTopology.testhostCount !== initialConcurrentProcesses
      || potentialTopology.testhostCount !== plannedConcurrentProcesses
      || potentialTopology.rollingPartitionCount !== rollingCoveragePartitionCount
      || initialTopology.allocatedCpuUnits !== initialCpuGrant
      || potentialTopology.allocatedCpuUnits !== potentialCpuBudget
      || initialTopology.invariants?.exactCpuConservation !== true
      || potentialTopology.invariants?.exactCpuConservation !== true
      || initialTopology.invariants?.affinityUnitsRemainIndivisible !== true
      || potentialTopology.invariants?.governanceIncludedInExactUnion !== true)
        {
            throw new Error('backend production shard summary has invalid topology planning evidence');
        }
    }
    if (!Array.isArray(summary?.memoryGiBByProcess)
    || summary.memoryGiBByProcess.length !== maxConcurrentProcesses
    || summary.memoryGiBByProcess.some((memoryGiB) => !positiveNumber(memoryGiB, null)))
    {
        throw new Error('backend production shard summary has an invalid memoryGiBByProcess allocation');
    }
    const allocatedMemoryGiB = summary.memoryGiBByProcess.reduce((total, memoryGiB) => total + memoryGiB, 0);
    const declaredAllocatedMemoryGiB = positiveNumber(summary.allocatedMemoryGiB, null);
    if (!declaredAllocatedMemoryGiB
    || Math.abs(allocatedMemoryGiB - declaredAllocatedMemoryGiB) > 1e-9)
    {
        throw new Error('backend production shard summary allocatedMemoryGiB does not match memoryGiBByProcess');
    }
    if (allocatedMemoryGiB > potentialMemoryBudget + 1e-9)
    {
        throw new Error('backend production shard summary memory allocation exceeds its potential budget');
    }
    const initialAllocatedMemoryGiB = summary.memoryGiBByProcess
        .slice(0, initialConcurrentProcesses)
        .reduce((total, memoryGiB) => total + memoryGiB, 0);
    if (initialAllocatedMemoryGiB > initialMemoryGrant + 1e-9)
    {
        throw new Error('backend production shard summary initial memory allocation exceeds its initial grant');
    }
    if (!dynamicExpansion)
    {
        const declaredMemoryGiB = positiveNumber(summary?.parallelism?.memoryGiB, null);
        if (!declaredMemoryGiB)
        {
            throw new Error('backend production shard summary is missing a valid parallelism.memoryGiB');
        }
        if (Math.abs(allocatedMemoryGiB - declaredMemoryGiB) > 1e-9)
        {
            throw new Error('backend production shard summary memoryGiBByProcess does not exactly consume its memory budget');
        }
    }
    if (!Array.isArray(summary?.partitions) || summary.partitions.length !== partitionCount)
    {
        throw new Error(`backend production shard summary expected ${partitionCount} partition entries`);
    }
    if (!Array.isArray(trxFiles) || trxFiles.length !== partitionCount)
    {
        throw new Error(`backend production expected ${partitionCount} partition TRX files, received ${trxFiles?.length ?? 0}`);
    }
    const actualTrx = new Set(trxFiles.map((file) => path.relative(repositoryRoot, file).replaceAll(path.sep, '/')));
    const reportTrx = new Set();
    const coverageRoots = new Set();
    for (let index = 0; index < partitionCount; index += 1)
    {
        const partition = summary.partitions[index];
        if (partition?.id !== index)
        {
            throw new Error(`backend production shard summary expected partition id ${index}`);
        }
        if (!Number.isInteger(partition?.processSlot)
      || partition.processSlot < 0
      || partition.processSlot >= maxConcurrentProcesses)
        {
            throw new Error(`backend production partition ${index} has an invalid process slot`);
        }
        const isPrelude = index < preludePartitionCount;
        if (isPrelude !== (partition?.kind === 'prelude'))
        {
            throw new Error(`backend production partition ${index} has an invalid prelude ordering marker`);
        }
        if (partition?.kind === 'governance-postlude')
        {
            throw new Error(`backend production partition ${index} reintroduced a governance postlude`);
        }
        if (!isPrelude && partition?.processors !== summary.processorsByProcess[partition.processSlot])
        {
            throw new Error(`backend production partition ${index} processor allocation is not bound to its process slot`);
        }
        if (isPrelude && (!positiveInteger(partition?.processors, null) || !positiveNumber(partition?.memoryGiB, null)))
        {
            throw new Error(`backend production prelude partition ${index} has an invalid resource allocation`);
        }
        if (!isPrelude && partition?.memoryGiB !== summary.memoryGiBByProcess[partition.processSlot])
        {
            throw new Error(`backend production partition ${index} memory allocation is not bound to its process slot`);
        }
        if (initialTopology !== undefined && !isPrelude)
        {
            const validUnavailableTiming = partition?.timingStatus === 'unavailable'
        && partition.firstTestStartedAtUnixMs === null
        && partition.testhostStartupMs === null
        && partition.testExecutionSpanMs === null;
            const validMeasuredTiming = partition?.timingStatus === 'measured'
        && Number.isFinite(partition.processStartedAtUnixMs)
        && Number.isFinite(partition.firstTestStartedAtUnixMs)
        && Number.isFinite(partition.testhostStartupMs)
        && partition.testhostStartupMs >= 0
        && Number.isFinite(partition.testExecutionSpanMs)
        && partition.testExecutionSpanMs >= 0;
            if (!validUnavailableTiming && !validMeasuredTiming)
            {
                throw new Error(`backend production partition ${index} has invalid testhost timing evidence`);
            }
        }
        if (typeof partition?.trx !== 'string' || !actualTrx.has(partition.trx))
        {
            throw new Error(`backend production partition ${index} TRX is not bound to an executed artifact`);
        }
        if (reportTrx.has(partition.trx))
        {
            throw new Error(`backend production shard summary repeats TRX ${partition.trx}`);
        }
        reportTrx.add(partition.trx);
        if (typeof partition?.coverageRoot !== 'string' || !partition.coverageRoot)
        {
            throw new Error(`backend production partition ${index} is missing its coverage root`);
        }
        if (coverageRoots.has(partition.coverageRoot))
        {
            throw new Error(`backend production shard summary repeats coverage root ${partition.coverageRoot}`);
        }
        coverageRoots.add(partition.coverageRoot);
    }
    return {
        partitionCount,
        maxConcurrentProcesses,
        initialConcurrentProcesses,
        peakConcurrentProcesses,
        potentialConcurrentProcesses,
        plannedConcurrentProcesses,
        globalPotentialConcurrentProcesses,
        processorsByProcess: [...summary.processorsByProcess],
        allocatedCpuUnits
    };
}

function escapeXml(value)
{
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&apos;');
}

function writeJsonAtomic(file, value)
{
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.next-${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(temporary, file);
}

function runDotnet(args, { capture = false, env = process.env } = {})
{
    return new Promise((resolve, reject) =>
    {
        const startedAt = Date.now();
        const child = spawn(path.join(root, 'tools/build-with-data-env.sh'), ['dotnet', ...args], {
            cwd: root,
            env,
            stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
        });
        let stdout = '';
        let stderr = '';
        if (capture)
        {
            child.stdout.on('data', (chunk) =>
            {
                stdout += chunk;
            });
            child.stderr.on('data', (chunk) =>
            {
                stderr += chunk;
            });
        }
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({
            code: code ?? 1,
            signal,
            stdout,
            stderr,
            startedAtUnixMs: startedAt,
            durationMs: Date.now() - startedAt
        }));
    });
}

function runNode(args, { capture = false, env = process.env } = {})
{
    return new Promise((resolve, reject) =>
    {
        const startedAt = Date.now();
        const child = spawn(process.execPath, args, {
            cwd: root,
            env,
            stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
        });
        let stdout = '';
        let stderr = '';
        if (capture)
        {
            child.stdout.on('data', (chunk) =>
            {
                stdout += chunk;
            });
            child.stderr.on('data', (chunk) =>
            {
                stderr += chunk;
            });
        }
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({
            code: code ?? 1,
            signal,
            stdout,
            stderr,
            durationMs: Date.now() - startedAt
        }));
    });
}

function runDocker(args, { capture = false, env = process.env } = {})
{
    return new Promise((resolve, reject) =>
    {
        const startedAt = Date.now();
        const child = spawn('docker', args, {
            cwd: root,
            env,
            stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
        });
        let stdout = '';
        let stderr = '';
        if (capture)
        {
            child.stdout.on('data', (chunk) =>
            {
                stdout += chunk;
            });
            child.stderr.on('data', (chunk) =>
            {
                stderr += chunk;
            });
        }
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({
            code: code ?? 1,
            signal,
            stdout,
            stderr,
            durationMs: Date.now() - startedAt
        }));
    });
}

async function listBackendPostgresContainers()
{
    const result = await runDocker(['ps', '--format', '{{.Names}}'], { capture: true });
    if (discoveryResultFailed(result))
    {
        throw new Error(`backend PostgreSQL container inventory failed: ${discoveryFailureDetail(result)}`);
    }
    return result.stdout.split(/\r?\n/u).map((name) => name.trim()).filter((name) =>
        backendPostgresContainerOwnerPid(name) !== null);
}

async function removeBackendPostgresContainers(containerNames)
{
    if (containerNames.length === 0)
    {
        return [];
    }
    const result = await runDocker(['rm', '-f', '-v', ...containerNames], { capture: true });
    if (discoveryResultFailed(result))
    {
        const remaining = new Set(await listBackendPostgresContainers());
        if (containerNames.every((containerName) => !remaining.has(containerName)))
        {
            return [...containerNames];
        }
        throw new Error(`backend PostgreSQL stale-container cleanup failed: ${discoveryFailureDetail(result)}`);
    }
    return [...containerNames];
}

function removeNewBackendPostgresContainersSync(baselineContainerNames, databaseNamespace)
{
    const inventory = spawnSync('docker', ['ps', '--format', '{{.Names}}'], {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true
    });
    if (inventory.status !== 0)
    {
        return [];
    }
    const baseline = new Set(baselineContainerNames);
    const ownedPrefix = `fsus-pg-${databaseNamespace}-`;
    const owned = inventory.stdout.split(/\r?\n/u).map((name) => name.trim()).filter((name) =>
        name.startsWith(ownedPrefix) && !baseline.has(name) && backendPostgresContainerOwnerPid(name) !== null);
    if (owned.length === 0)
    {
        return [];
    }
    const cleanup = spawnSync('docker', ['rm', '-f', '-v', ...owned], {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true
    });
    return cleanup.status === 0 ? owned : [];
}

function installBackendPostgresSignalCleanup(baselineContainerNames, databaseNamespace)
{
    const handlers = new Map();
    for (const signal of ['SIGTERM', 'SIGINT'])
    {
        const handler = () =>
        {
            removeNewBackendPostgresContainersSync(baselineContainerNames, databaseNamespace);
            for (const [registeredSignal, registeredHandler] of handlers)
            {
                process.removeListener(registeredSignal, registeredHandler);
            }
            process.kill(process.pid, signal);
        };
        handlers.set(signal, handler);
        process.once(signal, handler);
    }
    return () =>
    {
        for (const [signal, handler] of handlers)
        {
            process.removeListener(signal, handler);
        }
    };
}

function cleanupBackendBuildServers()
{
    return cleanupOrphanDotnetBuildServers({
        root,
        currentRunId: process.env.FSUSBLOG_TEST_RUN_ID ?? '',
        currentNamespace: process.env.FSUSBLOG_TEST_NAMESPACE ?? '',
        currentStartSource: process.env.FSUSBLOG_TEST_EXECUTION_SOURCE ?? '',
        includeCurrentBinding: true,
        terminationGraceMs: 250
    });
}

async function reclaimBackendTestResources()
{
    const startedAt = Date.now();
    const before = await listBackendPostgresContainers();
    const stale = staleBackendPostgresContainers(before);
    const staleContainerCleanupStartedAt = Date.now();
    const removedStaleContainers = await removeBackendPostgresContainers(stale);
    const staleContainerCleanupDurationMs = Date.now() - staleContainerCleanupStartedAt;
    const terminatedBuildServerPids = [];
    const baselineContainerNames = await listBackendPostgresContainers();
    return {
        removedStaleContainers,
        baselineContainerNames,
        terminatedBuildServerPids,
        staleContainerCleanupDurationMs,
        totalDurationMs: Date.now() - startedAt
    };
}

function prepareShardFiles(plan, outputRoot)
{
    const binSource = productionDotnet?.tests.outputDirectory
    ?? path.join(root, 'tests/backend/bin/Release/net10.0');
    const testAssembly = path.join(binSource, 'FsusBlog.Server.Tests.dll');
    const assets = JSON.parse(fs.readFileSync(productionDotnet?.tests.assetsFile
    ?? path.join(root, 'tests/backend/obj/project.assets.json'), 'utf8'));
    const coverletLibrary = Object.values(assets.libraries ?? {}).find((entry) => (
        entry?.type === 'package' && /^coverlet\.collector\//u.test(String(entry.path ?? ''))
    ));
    const packageRoot = Object.keys(assets.packageFolders ?? {})[0];
    if (!coverletLibrary || !packageRoot)
    {
        throw new Error('backend production shards cannot resolve coverlet.collector from project.assets.json');
    }
    const collectorDirectory = path.join(packageRoot, coverletLibrary.path, 'build/netstandard2.0');
    if (!fs.existsSync(path.join(collectorDirectory, 'coverlet.collector.dll')))
    {
        throw new Error('backend production shards resolved a missing coverlet.collector test adapter');
    }
    if (!fs.existsSync(testAssembly))
    {
        throw new Error(`backend production test assembly is missing: ${testAssembly}`);
    }
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.mkdirSync(outputRoot, { recursive: true });
    const affinityShardIds = new Set(Object.values(plan.affinityAssignments).map((entry) => entry.shardId));
    return plan.methodsByShard.map((methods, index) =>
    {
        const shardRoot = path.join(outputRoot, `shard-${index}`);
        const binDirectory = path.join(shardRoot, 'bin');
        const settingsFile = path.join(shardRoot, 'test.runsettings');
        fs.cpSync(binSource, binDirectory, {
            recursive: true,
            mode: fs.constants.COPYFILE_FICLONE
        });
        for (const requiredRuntimeFile of [
            'FsusBlog.Server.Tests.dll',
            'FsusBlog.Server.Tests.deps.json',
            'FsusBlog.Server.Tests.runtimeconfig.json'
        ])
        {
            if (!fs.existsSync(path.join(binDirectory, requiredRuntimeFile)))
            {
                throw new Error(`backend production shard ${index} is missing copied runtime file ${requiredRuntimeFile}`);
            }
        }
        const filter = methods.map((method) => `FullyQualifiedName=${method}`).join('|');
        fs.writeFileSync(settingsFile, `<RunSettings><RunConfiguration><TestCaseFilter>${escapeXml(filter)}</TestCaseFilter></RunConfiguration></RunSettings>\n`);
        return {
            index,
            methods,
            planningWeight: plan.planningWeightsByShard[index],
            testCaseCount: plan.plannedTestCaseCountsByShard[index],
            startupWeight: plan.startupWeightsByShard[index],
            affinityPriority: affinityShardIds.has(index),
            filter,
            filterDigest: `sha256:${sha256(filter)}`,
            binDirectory,
            settingsFile,
            collectorDirectory,
            executionDriver: 'vstest-copy'
        };
    });
}

export async function runRollingPartitions(partitions, processorsByProcess, runPartition, {
    initialMemoryGiBByProcess = null,
    readResourceGrant = null,
    potentialProcessCount = processorsByProcess.length,
    potentialCpuUnits = null,
    potentialMemoryGiB = null,
    ioOvercommit = null,
    waitForResourceChange = null,
    pollIntervalMs = Math.max(10, Math.ceil(1000 / Math.max(1, potentialProcessCount)))
} = {})
{
    if (!Array.isArray(partitions) || partitions.length === 0)
    {
        throw new Error('backend production rolling execution requires partitions');
    }
    if (!Array.isArray(processorsByProcess)
    || processorsByProcess.length < 1
    || processorsByProcess.some((processors) => !Number.isInteger(processors) || processors < 1))
    {
        throw new Error('backend production rolling execution requires positive processors per process');
    }
    if (processorsByProcess.length > partitions.length)
    {
        throw new Error('backend production rolling execution cannot have more processes than partitions');
    }
    if (typeof runPartition !== 'function')
    {
        throw new TypeError('backend production rolling execution requires a partition runner');
    }
    const dynamic = readResourceGrant !== null;
    if (dynamic && typeof readResourceGrant !== 'function')
    {
        throw new TypeError('backend production rolling execution resource grant reader must be a function');
    }
    if (!Number.isInteger(potentialProcessCount)
    || potentialProcessCount < processorsByProcess.length
    || potentialProcessCount > partitions.length)
    {
        throw new Error('backend production rolling execution potential process count is invalid');
    }
    const initialProcessorCount = processorsByProcess.reduce((sum, processors) => sum + processors, 0);
    const resolvedPotentialCpuUnits = potentialCpuUnits ?? Math.max(initialProcessorCount, potentialProcessCount);
    if (!Number.isInteger(resolvedPotentialCpuUnits) || resolvedPotentialCpuUnits < initialProcessorCount)
    {
        throw new Error('backend production rolling execution potential CPU capacity is invalid');
    }
    if (dynamic && (!Array.isArray(initialMemoryGiBByProcess)
    || initialMemoryGiBByProcess.length !== processorsByProcess.length
    || initialMemoryGiBByProcess.some((memoryGiB) => (
        !positiveNumber(memoryGiB, null)
      || memoryGiB + 1e-9 < backendTopologyDefaults.memoryGiBPerTesthost
    ))))
    {
        throw new Error('backend production rolling execution requires initial memory for every dynamic process slot');
    }
    if (dynamic && !positiveNumber(potentialMemoryGiB, null))
    {
        throw new Error('backend production rolling execution requires positive potential memory');
    }
    if (waitForResourceChange !== null && typeof waitForResourceChange !== 'function')
    {
        throw new TypeError('backend production rolling execution resource wait must be a function');
    }
    if (!positiveNumber(pollIntervalMs, null))
    {
        throw new Error('backend production rolling execution resource poll interval must be positive');
    }
    if (ioOvercommit !== null && (ioOvercommit?.enabled !== true
    || !positiveNumber(ioOvercommit.memoryGiBPerProcess, null)
    || typeof ioOvercommit.readAvailableMemoryGiB !== 'function'))
    {
        throw new Error('backend production I/O overcommit requires a memory reservation and host memory probe');
    }
    const outcomes = new Array(partitions.length);
    const partitionIds = partitions.map((partition) => partition?.index);
    if (partitionIds.some((id) => !Number.isInteger(id) || id < 0 || id >= partitions.length)
    || new Set(partitionIds).size !== partitions.length)
    {
        throw new Error('backend production rolling execution requires unique contiguous partition ids');
    }
    const executionQueue = [...partitions].sort((left, right) => (
        Number(Boolean(right.affinityPriority)) - Number(Boolean(left.affinityPriority))
    || (Number(right.planningWeight) || 0) - (Number(left.planningWeight) || 0)
    || (Number(right.testCaseCount) || 0) - (Number(left.testCaseCount) || 0)
    || (Number(right.startupWeight) || 0) - (Number(left.startupWeight) || 0)
    || left.index - right.index
    ));
    let nextPartition = 0;
    let activeProcesses = 0;
    let peakConcurrentProcesses = 0;
    let observedGrant = null;
    let expansionFailure = null;
    const activePartitionSlots = new Set();
    let activeAffinityProcesses = 0;
    let ioOvercommitSlot = null;
    let ioOvercommitObservedAvailableMemoryGiB = null;
    let ioOvercommitExecutedPartitionCount = 0;
    const slots = processorsByProcess.map((processors, processSlot) => ({
        processSlot,
        processors,
        memoryGiB: initialMemoryGiBByProcess?.[processSlot] ?? null
    }));
    const workers = [];
    let stateWaiter = null;
    const signalStateChange = () =>
    {
        stateWaiter?.();
        stateWaiter = null;
    };
    const waitForStateChange = () => new Promise((resolve) =>
    {
        stateWaiter = resolve;
    });
    const initialAllocatedCpuUnits = slots.reduce((total, slot) => total + slot.processors, 0);
    const initialAllocatedMemoryGiB = dynamic
        ? slots.reduce((total, slot) => total + slot.memoryGiB, 0)
        : null;
    if (dynamic && potentialProcessCount > slots.length
    && potentialMemoryGiB <= initialAllocatedMemoryGiB)
    {
        throw new Error('backend production rolling execution has no memory capacity for potential process slots');
    }
    const readValidatedResourceGrant = async () =>
    {
        const grant = await readResourceGrant();
        const cpuUnits = Number(grant?.cpuUnits);
        const memoryGiB = Number(grant?.memoryGiB);
        if (!Number.isInteger(cpuUnits) || cpuUnits < 1 || !positiveNumber(memoryGiB, null))
        {
            throw new Error('backend production rolling execution received an invalid live resource grant');
        }
        if (cpuUnits > resolvedPotentialCpuUnits || memoryGiB > potentialMemoryGiB + 1e-9)
        {
            throw new Error('backend production rolling execution live grant exceeds potential capacity');
        }
        return { cpuUnits, memoryGiB };
    };
    if (dynamic)
    {
        observedGrant = await readValidatedResourceGrant();
        if (observedGrant.cpuUnits < initialAllocatedCpuUnits)
        {
            throw new Error('backend production rolling execution live grant is below initial slot allocations');
        }
        // The outer scheduler may rebalance memory after the sibling benchmark
        // build finishes but before any rolling worker starts. Since no testhost
        // owns the original reservation yet, bind the initial slots to the latest
        // live grant instead of rejecting a safe downward memory rebalance.
        if (observedGrant.memoryGiB + 1e-9 < initialAllocatedMemoryGiB)
        {
            const liveMemoryGiBPerSlot = observedGrant.memoryGiB / slots.length;
            if (liveMemoryGiBPerSlot + 1e-9 < backendTopologyDefaults.memoryGiBPerTesthost)
            {
                throw new Error('backend production rolling execution live grant cannot retain the per-testhost memory floor');
            }
            for (const slot of slots)
            {
                slot.memoryGiB = liveMemoryGiBPerSlot;
            }
        }
    }
    const startWorker = (slot) =>
    {
        const worker = (async () =>
        {
            activeProcesses += 1;
            peakConcurrentProcesses = Math.max(peakConcurrentProcesses, activeProcesses);
            let completedPartitions = 0;
            while (nextPartition < executionQueue.length
        && !expansionFailure
        && (slot.admission !== 'io-overcommit'
          || activeAffinityProcesses >= (observedGrant?.cpuUnits ?? Number.POSITIVE_INFINITY)))
            {
                if (dynamic)
                {
                    let admitted = false;
                    while (nextPartition < executionQueue.length && !expansionFailure)
                    {
                        try
                        {
                            const grant = await readValidatedResourceGrant();
                            const activeCpu = [...activePartitionSlots].reduce((sum, activeSlot) => sum + activeSlot.processors, 0);
                            const activeMemory = [...activePartitionSlots].reduce((sum, activeSlot) => sum + activeSlot.memoryGiB, 0);
                            // The optional I/O bridge retains its separately declared policy.
                            // Ordinary slots must re-admit every partition against current costs.
                            if (nextPartition < executionQueue.length && !expansionFailure
                                && (slot.admission === 'io-overcommit'
                                    || (activeCpu + slot.processors <= grant.cpuUnits
                                        && activeMemory + slot.memoryGiB <= grant.memoryGiB + 1e-9)))
                            {
                                activePartitionSlots.add(slot);
                                admitted = true;
                                break;
                            }
                        }
                        catch (error)
                        {
                            expansionFailure = error;
                            break;
                        }
                        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
                    }
                    if (!admitted)
                    {
                        break;
                    }
                }
                const queueIndex = nextPartition;
                nextPartition += 1;
                const partition = executionQueue[queueIndex];
                const index = partition.index;
                if (partition.affinityPriority)
                {
                    activeAffinityProcesses += 1;
                }
                try
                {
                    outcomes[index] = {
                        status: 'fulfilled',
                        partition,
                        processSlot: slot.processSlot,
                        processors: slot.processors,
                        memoryGiB: slot.memoryGiB,
                        value: await runPartition(partition, slot)
                    };
                }
                catch (error)
                {
                    outcomes[index] = {
                        status: 'rejected',
                        partition,
                        processSlot: slot.processSlot,
                        processors: slot.processors,
                        memoryGiB: slot.memoryGiB,
                        reason: error
                    };
                }
                finally
                {
                    activePartitionSlots.delete(slot);
                    if (partition.affinityPriority)
                    {
                        activeAffinityProcesses -= 1;
                    }
                    if (slot.admission === 'io-overcommit')
                    {
                        ioOvercommitExecutedPartitionCount += 1;
                    }
                    // eslint-disable-next-line no-unused-vars
                    completedPartitions += 1;
                }
            }
            activeProcesses -= 1;
            signalStateChange();
        })();
        workers.push(worker);
    };
    for (const slot of slots)
    {
        startWorker(slot);
    }

    if (dynamic)
    {
        while (nextPartition < executionQueue.length && activeProcesses > 0)
        {
            let expanded = false;
            try
            {
                const { cpuUnits, memoryGiB } = await readValidatedResourceGrant();
                const grantedSlots = slots.filter((slot) => slot.admission !== 'io-overcommit');
                const allocatedCpuUnits = grantedSlots.reduce((total, slot) => total + slot.processors, 0);
                const allocatedMemoryGiB = grantedSlots.reduce((total, slot) => total + slot.memoryGiB, 0);
                observedGrant = { cpuUnits, memoryGiB };
                const availableCpuSlots = Math.floor(cpuUnits - allocatedCpuUnits);
                const remainingMemoryGiB = memoryGiB - allocatedMemoryGiB;
                const memoryAvailableProcessCount = Math.floor(
                    (remainingMemoryGiB + 1e-9) / backendTopologyDefaults.memoryGiBPerTesthost
                );
                const addCount = Math.min(
                    availableCpuSlots,
                    memoryAvailableProcessCount,
                    potentialProcessCount - slots.length,
                    executionQueue.length - nextPartition
                );
                const admittedAddCount = remainingMemoryGiB > 1e-9 ? addCount : 0;
                const memoryGiBPerAddedProcess = admittedAddCount > 0
                    ? remainingMemoryGiB / admittedAddCount
                    : null;
                const processorsByAddedProcess = admittedAddCount > 0
                    ? allocateBackendTopologyProcessors(availableCpuSlots, admittedAddCount)
                    : [];
                for (let offset = 0; offset < admittedAddCount; offset += 1)
                {
                    const slot = {
                        processSlot: slots.length,
                        processors: processorsByAddedProcess[offset],
                        memoryGiB: memoryGiBPerAddedProcess,
                        partitionLimit: null
                    };
                    slots.push(slot);
                    startWorker(slot);
                    expanded = true;
                }
                const nextQueuedPartition = executionQueue[nextPartition];
                if (ioOvercommit !== null
          && ioOvercommitSlot === null
          && nextQueuedPartition
          && !nextQueuedPartition.affinityPriority
          && activeAffinityProcesses >= cpuUnits
          && slots.length < potentialProcessCount)
                {
                    const availableMemoryGiB = Number(await ioOvercommit.readAvailableMemoryGiB());
                    const totalAllocatedMemoryGiB = slots.reduce((total, slot) => total + slot.memoryGiB, 0);
                    if (positiveNumber(availableMemoryGiB, null)
            && availableMemoryGiB >= ioOvercommit.memoryGiBPerProcess
            && totalAllocatedMemoryGiB + ioOvercommit.memoryGiBPerProcess <= potentialMemoryGiB + 1e-9)
                    {
                        ioOvercommitObservedAvailableMemoryGiB = availableMemoryGiB;
                        ioOvercommitSlot = {
                            processSlot: slots.length,
                            processors: 1,
                            memoryGiB: ioOvercommit.memoryGiBPerProcess,
                            admission: 'io-overcommit'
                        };
                        slots.push(ioOvercommitSlot);
                        startWorker(ioOvercommitSlot);
                        expanded = true;
                    }
                }
            }
            catch (error)
            {
                expansionFailure = error;
                break;
            }
            if (!expanded && nextPartition < executionQueue.length && activeProcesses > 0)
            {
                const resourceWait = waitForResourceChange
                    ? waitForResourceChange()
                    : new Promise((resolve) =>
{
              const timer = setTimeout(resolve, pollIntervalMs);
              timer.unref?.();
            });
                await Promise.race([waitForStateChange(), resourceWait]);
            }
        }
    }

    await Promise.all(workers);
    if (expansionFailure)
    {
        throw expansionFailure;
    }
    Object.defineProperty(outcomes, 'rollingExecution', {
        enumerable: false,
        value: {
            dynamic,
            initialConcurrentProcesses: processorsByProcess.length,
            peakConcurrentProcesses,
            potentialConcurrentProcesses: potentialProcessCount,
            // eslint-disable-next-line no-unused-vars
            slots: slots.map(({ partitionLimit, ...slot }) => ({ ...slot })),
            observedGrant,
            ...(ioOvercommit === null ? {} : { ioOvercommit: {
        enabled: ioOvercommit !== null,
        admittedProcessCount: ioOvercommitSlot === null ? 0 : 1,
        peakCpuOvercommitUnits: ioOvercommitSlot === null ? 0 : 1,
        executedPartitionCount: ioOvercommitExecutedPartitionCount,
        memoryGiBPerProcess: ioOvercommit?.memoryGiBPerProcess ?? null,
        observedAvailableMemoryGiB: ioOvercommitObservedAvailableMemoryGiB,
        reason: 'bridge-ordinary-coverage-while-postgres-affinity-is-io-bound'
      } })
        }
    });
    return outcomes;
}

export function aggregatePartitionExecutionFailures(outcomes)
{
    const failures = outcomes.filter((outcome) => (
        outcome.status === 'rejected'
    || outcome.value?.code !== 0
    || outcome.value?.signal
    ));
    if (failures.length === 0)
    {
        return null;
    }
    return new AggregateError(failures.map((outcome) =>
    {
        const id = outcome.value?.index ?? outcome.partition?.index ?? outcome.reason?.partitionId ?? 'unknown';
        if (outcome.status === 'rejected')
        {
            return new Error(`partition ${id}: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`);
        }
        return new Error(`partition ${id}: ${outcome.value.signal ?? `exit ${outcome.value.code}`}`);
    }), `backend production failed ${failures.length} rolling partitions`);
}

async function runBackendProductionShardsCore({
    parallelism = resolveBackendShardParallelism()
} = {})
{
    const { maxConcurrentProcesses } = parallelism;
    const initialSchedulerGrant = readBackendSchedulerResourceGrant();
    const schedulerGlobalPotentialProcessCount = resolveBackendPotentialProcessCount(initialSchedulerGrant, {
        availableCpu: parallelism.availableCpu,
        totalMemoryGiB: parallelism.totalMemoryGiB
    });
    const schedulerPlannedProcessCount = initialSchedulerGrant
        ? Math.min(initialSchedulerGrant.cpuUnits, schedulerGlobalPotentialProcessCount)
        : null;
    const testResultsRoot = productionTrxRoot();
    const coverageRoot = productionCoverageRoot();
    const summaryFile = path.join(testResultsRoot, 'summary.json');
    fs.rmSync(testResultsRoot, { recursive: true, force: true });
    fs.rmSync(coverageRoot, { recursive: true, force: true });
    fs.mkdirSync(testResultsRoot, { recursive: true });
    fs.mkdirSync(coverageRoot, { recursive: true });

    const mainFilter = productionFilter;
    const mainTrxFile = path.join(testResultsRoot, 'main-coverage.trx');
    const mainCoverageRoot = path.join(coverageRoot, 'main');
    const discoveryRoot = path.join(testResultsRoot, 'discovery');
    fs.mkdirSync(mainCoverageRoot, { recursive: true });
    fs.mkdirSync(discoveryRoot, { recursive: true });
    for (const staleEvidence of [
        process.env.FSUSBLOG_PERCEPTION_RUNTIME_EVIDENCE_FILE ?? path.join(root, '.tmp/security/perception-v2-e2e-runtime.json'),
        process.env.FSUSBLOG_PERCEPTION_MATRIX_SUMMARY_FILE ?? path.join(root, '.tmp/security/perception-v2-test-matrix.json'),
        process.env.FSUSBLOG_PERCEPTION_RELEASE_EVIDENCE_FILE
      ?? productionFreshOutputPath('release-evidence', 'perception-v2-release-evidence.json')
      ?? path.join(root, '.tmp/release-evidence/perception-v2-release-evidence.json')
    ])
    {
        fs.rmSync(path.resolve(staleEvidence), { force: true });
    }
    const mainDatabaseNamespace = backendProductionDatabaseNamespace('main');
    const resourceHygiene = await reclaimBackendTestResources();
    const uninstallSignalCleanup = installBackendPostgresSignalCleanup(
        resourceHygiene.baselineContainerNames,
        mainDatabaseNamespace
    );
    let mainResult;
    let productionDiscovery;
    let discoveryDiagnostic;
    let platformPlan;
    let authoritativeRecords;
    let testNames;
    // eslint-disable-next-line no-useless-assignment
    let removedOwnedContainers = [];
    try
    {
        productionDiscovery = await runDotnet([
            'vstest', testAssembly,
            '--ListTests',
            `--Diag:${path.join(discoveryRoot, 'union.txt')}`
        ], { capture: true, env: backendPartitionEnvironment(process.env, {
            processors: 1,
            memoryGiB: parallelism.memoryGiB,
            namespace: `${mainDatabaseNamespace}-discovery`
        }) });
        if (discoveryResultFailed(productionDiscovery))
        {
            throw new Error(`backend production discovery failed: ${discoveryFailureDetail(productionDiscovery)}`);
        }
        const allTestNames = parseListedTests(productionDiscovery.stdout);
        discoveryDiagnostic = readVstestDiscoveryDiagnostic(discoveryRoot, {
            expectedSource: path.resolve(root, testAssembly)
        });
        const allAuthoritativeRecords = alignAuthoritativeDiscovery(allTestNames, discoveryDiagnostic.records);
        platformPlan = projectProductionPlatformPlan(allAuthoritativeRecords);
        authoritativeRecords = projectProductionUnionRecords(allAuthoritativeRecords);
        testNames = authoritativeRecords.map((record) => record.displayName);

        mainResult = await runDotnet([
            'test', project, '-c', 'Release', '--no-build', '--no-restore', '-v', 'minimal',
            '--filter', mainFilter,
            '--logger', `trx;LogFileName=${mainTrxFile}`,
            '--collect:XPlat Code Coverage',
            '--results-directory', mainCoverageRoot,
            '--', 'DataCollectionRunSettings.DataCollectors.DataCollector.Configuration.Format=json'
        ], { env: backendPartitionEnvironment(process.env, {
            processors: parallelism.cpuBudget,
            memoryGiB: parallelism.memoryGiB,
            namespace: mainDatabaseNamespace
        }) });
    }
    finally
    {
        removedOwnedContainers = removeNewBackendPostgresContainersSync(
            resourceHygiene.baselineContainerNames,
            mainDatabaseNamespace
        );
        uninstallSignalCleanup();
    }
    if (discoveryResultFailed(mainResult))
    {
        throw new Error(`backend production coverage main failed: ${discoveryFailureDetail(mainResult)}`);
    }
    const coverageBinding = resolveCoverageBinding();
    prepareCoverageShard({
        directory: mainCoverageRoot,
        shardId: 'production-main',
        binding: coverageBinding
    });
    const mainEvidence = parseTrxExecutionEvidence(fs.readFileSync(mainTrxFile, 'utf8'));
    const mainRecords = mainEvidence.records;
    const evidenceResult = await runNode(['tools/security/check-perception-v2-e2e-evidence.mjs'], { capture: true });
    if (discoveryResultFailed(evidenceResult))
    {
        throw new Error(`backend Perception evidence finalization failed: ${discoveryFailureDetail(evidenceResult)}`);
    }
    const terminatedBuildServerPostflightPids = cleanupBackendBuildServers();
    const executionIds = new Set(mainRecords.map((record) => record.testId));
    if (executionIds.size !== mainRecords.length)
    {
        throw new Error('backend production TRX partitions repeat a stable test ID');
    }
    const postgresManifest = JSON.parse(fs.readFileSync(
        path.join(root, 'tests/backend/Fixtures/postgres-test-collections.json'),
        'utf8'
    ));
    const postgresPlanningWeights = buildPostgresCollectionPlanningWeights(testNames, postgresManifest, {
        manifestExcludedClasses: readManifestClassWideProductionExclusions(postgresManifest)
    });
    for (const weight of postgresPlanningWeights)
    {
        weight.classStartupPenalty = deriveClassStartupPenalty(weight.testNames, weight.estimatedFacts);
    }
    const partitioning = deriveBackendPartitionCount(testNames, {
        maxConcurrentProcesses,
        potentialConcurrentProcesses: schedulerPlannedProcessCount,
        affinityGroups: []
    });
    const { partitionCount } = partitioning;
    const plan = buildShardPlan(testNames, partitionCount, Array.from({ length: partitionCount }, () => 1));
    const validation = validateExactProductionUnion(testNames, [mainRecords], {
        authoritativeRecords
    });
    const platformOutcome = reconcileBackendPlatformOutcome(platformPlan, mainRecords);
    const summary = {
        schema: 'fsusblog.backend-production-shards.v2',
        status: 'success',
        filter: productionFilter,
        executionMode: 'single-testhost-exact-union',
        partitionCount: 1,
        maxConcurrentProcesses: 1,
        initialConcurrentProcesses: 1,
        peakConcurrentProcesses: 1,
        potentialConcurrentProcesses: 1,
        plannedConcurrentProcesses: 1,
        globalPotentialConcurrentProcesses: 1,
        processorsByProcess: [parallelism.cpuBudget],
        memoryGiBByProcess: [parallelism.memoryGiB],
        allocatedCpuUnits: parallelism.cpuBudget,
        allocatedMemoryGiB: parallelism.memoryGiB,
        parallelism,
        resourceExpansion: {
            dynamic: false,
            initialGrant: {
                cpuUnits: parallelism.cpuBudget,
                memoryGiB: parallelism.memoryGiB
            },
            observedGrant: null,
            potentialBudget: {
                cpuUnits: parallelism.cpuBudget,
                memoryGiB: parallelism.memoryGiB
            }
        },
        resourceHygiene: {
            staleOwnerPolicy: 'container-name-owner-pid-must-be-dead',
            databaseNamespace: mainDatabaseNamespace,
            removedStaleContainerCount: resourceHygiene.removedStaleContainers.length,
            removedStaleContainers: resourceHygiene.removedStaleContainers,
            removedOwnedContainerCount: removedOwnedContainers.length,
            removedOwnedContainers,
            retainedBaselineContainerCount: resourceHygiene.baselineContainerNames.length,
            terminatedBuildServerCount: resourceHygiene.terminatedBuildServerPids.length,
            terminatedBuildServerPids: resourceHygiene.terminatedBuildServerPids,
            terminatedBuildServerPostflightCount: terminatedBuildServerPostflightPids.length,
            terminatedBuildServerPostflightPids,
            staleContainerCleanupDurationMs: resourceHygiene.staleContainerCleanupDurationMs,
            totalDurationMs: resourceHygiene.totalDurationMs
        },
        planningForecast: {
            partitioning,
            partitionCount,
            plannedTestCaseCountsByShard: plan.plannedTestCaseCountsByShard,
            planningWeightsByShard: plan.planningWeightsByShard,
            partitionUnitKind: plan.partitionUnitKind,
            partitionDigest: plan.partitionDigest,
            executionPolicy: 'unweighted-observed-class-forecast-only-single-testhost-execution'
        },
        discovery: {
            testCaseCount: testNames.length,
            testMethodCount: new Set(testNames.map(normalizeListedTestName)).size,
            durationMs: productionDiscovery.durationMs,
            wallDurationMs: productionDiscovery.durationMs,
            branchCount: 1,
            maxParallel: 1,
            processorsPerBranch: 1,
            executionIntegrated: false,
            diagnostic: path.relative(root, discoveryDiagnostic.file).replaceAll(path.sep, '/'),
            authoritativeTraitSource: {
                protocol: 'VSTest TestDiscovery diagnostic IDs and traits',
                trxDigests: [mainTrxFile].map((file) => `sha256:${sha256(fs.readFileSync(file))}`),
                productionTestCaseCount: testNames.length,
                mainTestCaseCount: mainEvidence.counters.executed,
                governanceRequirementTestCaseCount: 1,
                selectedTestIdCount: executionIds.size
            }
        },
        platformMembership: platformPlan,
        platformOutcome,
        execution: {
            ...validation,
            mainTestCaseCount: mainRecords.length,
            governanceRequirementTestCaseCount: 1,
            coverageMainFilter: mainFilter,
            evidenceCheckerRuns: 1
        },
        postgresCollectionPlanning: Object.fromEntries(postgresPlanningWeights.map((group) => [group.collectionId, {
            source: group.source,
            planningMode: 'manifest-projection-only',
            safetyBoundary: 'each testhost uses an isolated namespace/database; xUnit collection serialization remains process-local',
            estimatedFacts: group.estimatedFacts,
            excludedTestCaseCount: group.excludedTestCaseCount,
            testClassCount: group.testClasses.length,
            testClasses: group.testClasses,
            testCaseCount: group.testNames.length
        }])),
        partitions: [{
            id: 0,
            kind: 'coverage-exact-union',
            processSlot: 0,
            processors: parallelism.cpuBudget,
            memoryGiB: parallelism.memoryGiB,
            testCaseCount: mainRecords.length,
            testMethodCount: new Set(mainRecords.map((record) => normalizeListedTestName(record.testName))).size,
            filterDigest: `sha256:${sha256(mainFilter)}`,
            durationMs: mainResult.durationMs,
            trx: path.relative(root, mainTrxFile).replaceAll(path.sep, '/'),
            coverageRoot: path.relative(root, mainCoverageRoot).replaceAll(path.sep, '/')
        }],
        producer: {
            runId: process.env.FSUSBLOG_TEST_RUN_ID ?? null,
            sourceCommit: process.env.FSUSBLOG_TEST_SOURCE_COMMIT ?? null,
            sourceFingerprint: process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT ?? null
        },
        buildBinding: canonicalBackendBuildBinding(),
        generatedAt: new Date().toISOString()
    };
    validateShardSummaryArtifacts(summary, [mainTrxFile]);
    writeCoverageUniverse({
        file: path.join(coverageRoot, 'universe.json'),
        shards: [{ id: 'production-main', directory: mainCoverageRoot }],
        binding: coverageBinding
    });
    writeJsonAtomic(summaryFile, summary);
    console.log(
        `[backend-production-shards] ok tests=${validation.executedTestCaseCount} methods=${validation.executedMethodCount} `
    + `testhosts=1 coverageTesthosts=1 exactOnce=${validation.exactOnce}`
    );
    return summary;
}

async function runExpandableBackendProductionShards({
    parallelism = resolveBackendShardParallelism()
} = {})
{
    const outerSchedulerGrant = readBackendSchedulerResourceGrant();
    if (!outerSchedulerGrant)
    {
        return runBackendProductionShardsCore({ parallelism });
    }
    // The union can start while the benchmark project still owns a sibling step
    // grant. Bind its initial slots to the admitted STEP envelope, then allow the
    // run-bound benchmark marker to expose the larger outer bundle grant.
    const initialGrant = {
        ...outerSchedulerGrant,
        cpuUnits: parallelism.cpuBudget,
        memoryGiB: parallelism.memoryGiB
    };
    const globalPotential = resolveBackendPotentialProcessCount(outerSchedulerGrant, {
        availableCpu: parallelism.availableCpu,
        totalMemoryGiB: parallelism.totalMemoryGiB
    });
    const initialProcessCount = Math.min(parallelism.maxConcurrentProcesses, initialGrant.cpuUnits);
    const potentialProcessCount = Math.max(initialProcessCount, globalPotential);
    const testResultsRoot = productionTrxRoot();
    const coverageRoot = productionCoverageRoot();
    const summaryFile = path.join(testResultsRoot, 'summary.json');
    const discoveryRoot = path.join(testResultsRoot, 'discovery');
    fs.rmSync(testResultsRoot, { recursive: true, force: true });
    fs.rmSync(coverageRoot, { recursive: true, force: true });
    fs.mkdirSync(discoveryRoot, { recursive: true });
    fs.mkdirSync(coverageRoot, { recursive: true });

    const resourceHygiene = await reclaimBackendTestResources();
    const databaseNamespace = backendProductionDatabaseNamespace('main');
    const uninstallSignalCleanup = installBackendPostgresSignalCleanup(
        resourceHygiene.baselineContainerNames,
        databaseNamespace
    );
    let removedOwnedContainers = [];
    try
    {
        const diagnosticFile = path.join(discoveryRoot, 'union.txt');
        const discovery = await runDotnet([
            'vstest', testAssembly,
            '--ListTests',
            `--Diag:${diagnosticFile}`
        ], { capture: true, env: backendPartitionEnvironment(process.env, {
            processors: 1,
            memoryGiB: initialGrant.memoryGiB,
            namespace: `${databaseNamespace}-discovery`
        }) });
        if (discoveryResultFailed(discovery))
        {
            throw new Error(`backend production discovery failed: ${discoveryFailureDetail(discovery)}`);
        }
        const allTestNames = parseListedTests(discovery.stdout);
        const diagnostic = readVstestDiscoveryDiagnostic(discoveryRoot, {
            expectedSource: path.resolve(root, testAssembly)
        });
        const allAuthoritativeRecords = alignAuthoritativeDiscovery(allTestNames, diagnostic.records);
        const platformPlan = projectProductionPlatformPlan(allAuthoritativeRecords);
        const authoritativeRecords = projectProductionUnionRecords(allAuthoritativeRecords);
        const testNames = authoritativeRecords.map((record) => record.displayName);
        const mainTestNames = testNames;
        const categoryTests = projectTraitMembership(authoritativeRecords, 'Category', projectedCategories);
        const affinityTests = projectTraitMembership(authoritativeRecords, 'ShardAffinity', shardAffinities);
        const dependencyTests = projectTraitMembership(authoritativeRecords, 'Dependency', weightedDependencies);
        const postgresManifest = JSON.parse(fs.readFileSync(
            path.join(root, 'tests/backend/Fixtures/postgres-test-collections.json'),
            'utf8'
        ));
        const postgresGroups = buildPostgresCollectionPlanningWeights(mainTestNames, postgresManifest, {
            manifestExcludedClasses: readManifestClassWideProductionExclusions(postgresManifest)
        });
        for (const group of postgresGroups)
        {
            group.classStartupPenalty = deriveClassStartupPenalty(group.testNames, group.estimatedFacts);
        }
        const applicationWeights = Object.entries(affinityTests).map(([name, names]) => ({
            name,
            testNames: names,
            classStartupPenalty: deriveColdApplicationStartupPenalty(mainTestNames.length)
        }));
        // PostgreSQL classes stay intact, while independent testhosts own isolated
        // database namespaces. Use the machine-derived potential only as an upper
        // bound: collection pressure decides whether another testhost is useful.
        const affinityGroups = buildPostgresAffinityGroups(
            postgresGroups,
            potentialProcessCount
        );
        const dependencyWeights = [
            ...applicationWeights,
            ...Object.entries(dependencyTests).map(([name, names]) => ({
                name,
                testNames: names,
                classStartupPenalty: deriveClassStartupPenalty(names)
            }))
        ];
        const partitionMultiplier = positiveNumber(
            process.env.FSUSBLOG_BACKEND_PARTITION_MULTIPLIER,
            backendTopologyDefaults.partitionMultiplier
        );
        if (partitionMultiplier < 1)
        {
            throw new Error('backend production partition multiplier must be a number of at least one');
        }
        const planningUnitProbe = deriveBackendPartitionCount(mainTestNames, {
            maxConcurrentProcesses: 2,
            affinityGroups,
            partitionMultiplier
        });
        const testhostOverride = configuredPositiveInteger(
            process.env.FSUSBLOG_BACKEND_PRODUCTION_SHARDS,
            'backend production diagnostic process override'
        );
        const processorAllocationMode = String(
            process.env.FSUSBLOG_BACKEND_PROCESSOR_ALLOCATION_MODE ?? 'uniform'
        ).trim();
        const weightedDependencyCount = new Set(
            Object.values(dependencyTests).flat().map(normalizeListedTestName)
        ).size;
        const topologyInputs = {
            planningUnitCount: planningUnitProbe.planningUnitCount,
            productionTestCaseCount: mainTestNames.length,
            coldApplicationStartupPenalty: deriveColdApplicationStartupPenalty(mainTestNames.length),
            classStartupPenalty: deriveClassStartupPenalty(mainTestNames),
            weightedDependencyCount,
            affinityGroupCount: affinityGroups.length,
            testhostOverride,
            partitionMultiplier,
            processorAllocationMode
        };
        const initialTopology = planBackendProductionTopology({
            ...topologyInputs,
            testhostOverride: testhostOverride === null
                ? null
                : Math.min(
            testhostOverride,
            initialGrant.cpuUnits,
            Math.floor(initialGrant.memoryGiB / backendTopologyDefaults.memoryGiBPerTesthost)
          ),
            cpuBudget: initialGrant.cpuUnits,
            memoryGiB: initialGrant.memoryGiB
        });
        const potentialTopology = planBackendProductionTopology({
            ...topologyInputs,
            cpuBudget: outerSchedulerGrant.resourceBudget.cpuUnits,
            memoryGiB: outerSchedulerGrant.resourceBudget.memoryGiB
        });
        const partitioning = {
            ...planningUnitProbe,
            partitionCount: potentialTopology.rollingPartitionCount,
            formula: potentialTopology.formula,
            partitionMultiplier
        };
        const plannedProcessCount = potentialTopology.testhostCount;
        const plan = buildShardPlan(
            mainTestNames,
            potentialTopology.rollingPartitionCount,
            Array.from({ length: potentialTopology.rollingPartitionCount }, () => 1),
            {
                affinityGroups,
                dependencyWeights,
                exclusiveAffinityGroups: affinityGroups.map((group) => group.name)
            }
        );
        const partitions = prepareShardFiles(plan, path.join(testResultsRoot, 'partitions'));
        const backendTempRoot = path.join(resolveBackendTempRoot({
            repositoryTempRoot: path.join(testResultsRoot, 'tmp')
        }), `fsusblog-backend-${String(process.env.FSUSBLOG_TEST_RUN_ID ?? 'local').replace(/[^A-Za-z0-9_.-]/gu, '-')}`);
        const initialProcessorsByProcess = initialTopology.processorsByTesthost;
        const initialMemoryGiBByProcess = initialTopology.memoryGiBByTesthost;
        const outcomes = await runRollingPartitions(
            partitions,
            initialProcessorsByProcess,
            async (partition, slot) =>
            {
                const resultRoot = path.join(coverageRoot, `shard-${partition.index}`);
                const trxFile = path.join(testResultsRoot, `shard-${partition.index}.trx`);
                const collectorTrxFile = path.join(resultRoot, path.basename(trxFile));
                const tempDirectory = path.join(backendTempRoot, `shard-${partition.index}`);
                fs.mkdirSync(resultRoot, { recursive: true });
                fs.mkdirSync(tempDirectory, { recursive: true });
                console.log(
                    `[backend-production-shards] start shard=${partition.index}`
          + ` planningWeight=${partition.planningWeight}`
          + ` testCases=${partition.testCaseCount}`
          + ` startupWeight=${partition.startupWeight}`
          + ` slot=${slot.processSlot}`
                );
                const command = [
                    'vstest', path.join(partition.binDirectory, path.basename(testAssembly)),
                    `--Settings:${partition.settingsFile}`,
                    `--TestAdapterPath:${partition.collectorDirectory}`,
                    `--logger:trx;LogFileName=${path.basename(trxFile)}`,
                    `--ResultsDirectory:${resultRoot}`,
                    '--Collect:XPlat Code Coverage',
                    '--', 'DataCollectionRunSettings.DataCollectors.DataCollector.Configuration.Format=json'
                ];
                const result = await runDotnet(command, { env: backendPartitionEnvironment(process.env, {
                    processors: slot.processors,
                    memoryGiB: slot.memoryGiB,
                    namespace: `${databaseNamespace}-s${partition.index}`,
                    tempDirectory
                }) });
                if (fs.existsSync(collectorTrxFile))
                {
                    fs.copyFileSync(collectorTrxFile, trxFile);
                    fs.rmSync(collectorTrxFile);
                }
                else if (!discoveryResultFailed(result))
                {
                    throw new Error(`backend production shard ${partition.index} did not write ${collectorTrxFile}`);
                }
                if (!discoveryResultFailed(result))
                {
                    prepareCoverageShard({
                        directory: resultRoot,
                        shardId: `production-${partition.index}`,
                        binding: resolveCoverageBinding()
                    });
                }
                return { ...result, index: partition.index, trxFile, coverageRoot: resultRoot };
            }, {
                initialMemoryGiBByProcess,
                readResourceGrant: () => readBackendResourceGrantAfterBenchmark({
                    initialGrant,
                    readSchedulerGrant: () => readBackendSchedulerResourceGrant()
                }),
                potentialProcessCount: plannedProcessCount,
                potentialCpuUnits: outerSchedulerGrant.resourceBudget.cpuUnits,
                potentialMemoryGiB: outerSchedulerGrant.resourceBudget.memoryGiB
            }
        );
        const executionFailure = aggregatePartitionExecutionFailures(outcomes);
        if (executionFailure)
        {
            throw executionFailure;
        }
        const recordsByShard = outcomes.map((outcome) => (
            parseTrxExecutionEvidence(fs.readFileSync(outcome.value.trxFile, 'utf8')).records
        ));
        const timingsByShard = outcomes.map((outcome) => (
            parseTrxTimingEvidence(fs.readFileSync(outcome.value.trxFile, 'utf8'))
        ));
        validateShardRecords(plan, recordsByShard);
        const evidenceResult = await runNode(['tools/security/check-perception-v2-e2e-evidence.mjs'], { capture: true });
        if (discoveryResultFailed(evidenceResult))
        {
            throw new Error(`backend Perception evidence finalization failed: ${discoveryFailureDetail(evidenceResult)}`);
        }
        const mainRecords = recordsByShard.flat();
        const validation = validateExactProductionUnion(testNames, recordsByShard, {
            authoritativeRecords
        });
        const platformOutcome = reconcileBackendPlatformOutcome(platformPlan, mainRecords);
        const rolling = outcomes.rollingExecution;
        const slots = rolling.slots;
        const summary = {
            schema: 'fsusblog.backend-production-shards.v2',
            status: 'success',
            filter: productionFilter,
            executionMode: 'expandable-exact-partitions',
            partitionCount: outcomes.length,
            rollingPartitionCount: outcomes.length,
            postludePartitionCount: 0,
            maxConcurrentProcesses: rolling.peakConcurrentProcesses,
            initialConcurrentProcesses: rolling.initialConcurrentProcesses,
            peakConcurrentProcesses: rolling.peakConcurrentProcesses,
            potentialConcurrentProcesses: rolling.potentialConcurrentProcesses,
            plannedConcurrentProcesses: plannedProcessCount,
            globalPotentialConcurrentProcesses: globalPotential,
            processorsByProcess: slots.map((slot) => slot.processors),
            memoryGiBByProcess: slots.map((slot) => slot.memoryGiB),
            allocatedCpuUnits: slots.reduce((sum, slot) => sum + slot.processors, 0),
            allocatedMemoryGiB: slots.reduce((sum, slot) => sum + slot.memoryGiB, 0),
            parallelism,
            resourceExpansion: {
                dynamic: true,
                initialGrant: { cpuUnits: initialGrant.cpuUnits, memoryGiB: initialGrant.memoryGiB },
                observedGrant: rolling.observedGrant,
                potentialBudget: { ...outerSchedulerGrant.resourceBudget },
                ioOvercommit: rolling.ioOvercommit
            },
            resourceHygiene: {
                staleOwnerPolicy: 'container-name-owner-pid-must-be-dead',
                databaseNamespace,
                removedStaleContainerCount: resourceHygiene.removedStaleContainers.length,
                removedStaleContainers: resourceHygiene.removedStaleContainers,
                terminatedBuildServerCount: resourceHygiene.terminatedBuildServerPids.length,
                terminatedBuildServerPids: resourceHygiene.terminatedBuildServerPids
            },
            planningForecast: {
                initialTopology,
                potentialTopology,
                partitioning,
                partitionCount: outcomes.length,
                plannedTestCaseCountsByShard: plan.plannedTestCaseCountsByShard,
                planningWeightsByShard: plan.planningWeightsByShard,
                startupWeightsByShard: plan.startupWeightsByShard,
                partitionUnitKind: plan.partitionUnitKind,
                partitionDigest: plan.partitionDigest,
                affinityAssignments: plan.affinityAssignments,
                dependencyWeightAssignments: plan.dependencyWeightAssignments,
                executionPolicy: 'fixed-exact-partitions-expand-on-live-grant'
            },
            discovery: {
                testCaseCount: testNames.length,
                testMethodCount: new Set(testNames.map(normalizeListedTestName)).size,
                durationMs: discovery.durationMs,
                wallDurationMs: discovery.durationMs,
                branchCount: 1,
                maxParallel: 1,
                processorsPerBranch: 1,
                executionIntegrated: false,
                diagnostic: path.relative(root, diagnostic.file).replaceAll(path.sep, '/'),
                authoritativeTraitSource: {
                    protocol: 'VSTest TestDiscovery diagnostic IDs and traits',
                    productionTestCaseCount: authoritativeRecords.length,
                    selectedTestIdCount: new Set(authoritativeRecords.map((record) => record.id)).size
                }
            },
            platformMembership: platformPlan,
            platformOutcome,
            execution: {
                ...validation,
                mainTestCaseCount: mainRecords.length,
                governanceRequirementTestCaseCount: 1,
                evidenceCheckerRuns: 1
            },
            categoryMembership: Object.fromEntries(Object.entries(validateCategoryMembership(plan, categoryTests))
                .map(([category, methods]) => [category, { testMethods: methods }])),
            postgresCollectionPlanning: Object.fromEntries(postgresGroups.map((group) => [group.collectionId, {
                source: group.source,
                planningMode: 'shared-postgres-testhost-without-endpoint-bridge',
                estimatedFacts: group.estimatedFacts,
                excludedTestCaseCount: group.excludedTestCaseCount,
                testClassCount: group.testClasses.length,
                testClasses: group.testClasses,
                testCaseCount: group.testNames.length
            }])),
            partitions: [
                ...outcomes.map((outcome, id) => ({
                    id,
                    kind: 'coverage-shard',
                    processSlot: outcome.processSlot,
                    processors: outcome.processors,
                    memoryGiB: outcome.memoryGiB,
                    testCaseCount: recordsByShard[id].length,
                    testMethodCount: plan.methodsByShard[id].length,
                    planningWeight: plan.planningWeightsByShard[id],
                    plannedTestCaseCount: plan.plannedTestCaseCountsByShard[id],
                    startupWeight: plan.startupWeightsByShard[id],
                    filterDigest: plan.partitionDigest,
                    processStartedAtUnixMs: outcome.value.startedAtUnixMs,
                    firstTestStartedAtUnixMs: timingsByShard[id].firstTestStartedAtUnixMs,
                    testhostStartupMs: timingsByShard[id].status === 'measured'
                        ? Math.max(0, timingsByShard[id].firstTestStartedAtUnixMs - outcome.value.startedAtUnixMs)
                        : null,
                    testExecutionSpanMs: timingsByShard[id].testExecutionSpanMs,
                    timingStatus: timingsByShard[id].status,
                    durationMs: outcome.value.durationMs,
                    trx: path.relative(root, outcome.value.trxFile).replaceAll(path.sep, '/'),
                    coverageRoot: path.relative(root, outcome.value.coverageRoot).replaceAll(path.sep, '/')
                }))
            ],
            producer: {
                runId: process.env.FSUSBLOG_TEST_RUN_ID ?? null,
                sourceCommit: process.env.FSUSBLOG_TEST_SOURCE_COMMIT ?? null,
                sourceFingerprint: process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT ?? null
            },
            buildBinding: canonicalBackendBuildBinding(),
            generatedAt: new Date().toISOString()
        };
        const trxFiles = outcomes.map((outcome) => outcome.value.trxFile);
        validateShardSummaryArtifacts(summary, trxFiles);
        writeCoverageUniverse({
            file: path.join(coverageRoot, 'universe.json'),
            shards: outcomes.map((outcome) => ({
                id: `production-${outcome.value.index}`,
                directory: outcome.value.coverageRoot
            })),
            binding: resolveCoverageBinding()
        });
        writeJsonAtomic(summaryFile, summary);
        return summary;
    }
    finally
    {
        // eslint-disable-next-line no-unused-vars
        removedOwnedContainers = removeNewBackendPostgresContainersSync(
            resourceHygiene.baselineContainerNames,
            databaseNamespace
        );
        uninstallSignalCleanup();
    }
}

export async function runBackendProductionShards(options = {})
{
    try
    {
        return await runExpandableBackendProductionShards(options);
    }
    finally
    {
    // The strict run binding prevents this failure-path cleanup from touching
    // developer build servers or a sibling scheduler namespace.
        cleanupBackendBuildServers();
    }
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain)
{
    runBackendProductionShards().catch((error) =>
    {
        console.error(`[backend-production-shards] ${error instanceof Error ? error.message : String(error)}`);
        if (error instanceof AggregateError)
        {
            for (const failure of error.errors)
            {
                console.error(`[backend-production-shards] ${failure instanceof Error ? failure.message : String(failure)}`);
            }
        }
        process.exit(1);
    });
}
