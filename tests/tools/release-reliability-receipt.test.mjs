import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { createLoadExecutionPlan } = await import(new URL('../../tools/test/load-profile-window.mjs', import.meta.url));
const { calculateLoadSampleMetrics, normalizeLoadResourceObservability } = await import(new URL('../../tools/test/load-sample-metrics.mjs', import.meta.url));
const { behaviorTest } = await import(new URL('../../tools/contracts/behavior-test.mjs', import.meta.url));
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const {
    collectRunIdentity,
    createCandidateReceipt,
    createTimeline,
    digestValue,
    sealDocument
} = await import(pathToFileURL(path.join(repositoryRoot, 'tools/test/release-reliability-receipt.mjs')).href);
const {
    collectProductionToolchain,
    createProductionBuildReceipt
} = await import(pathToFileURL(path.join(repositoryRoot, 'tools/ci/production-build-artifacts.mjs')).href);
const {
    snapshotGitWorktree
} = await import(pathToFileURL(path.join(repositoryRoot, 'tools/test-matrix/scheduler.mjs')).href);
const {
    verifyLifecycleActionReceipt
} = await import(pathToFileURL(path.join(
    repositoryRoot,
    'tools/test/verify-release-reliability-lifecycle-action.mjs'
)).href);
const {
    projectQualifiedContainerEnvironment,
    releaseReliabilityAuditedContainerOverrides
} = await import(pathToFileURL(path.join(
    repositoryRoot,
    'tools/test/release-reliability-runtime-environment.mjs'
)).href);
const { createCleanAttemptEvidenceFixture } = await import(new URL(
    './support/clean-attempt-evidence-fixture.mjs',
    import.meta.url
));

const verifier = path.join(repositoryRoot, 'tools/test/verify-release-reliability-receipt.mjs');
const scenarioIds = [
    'release-soak-min',
    'release-load-peak',
    'release-load-burst',
    'release-data-scale-m',
    'release-mutation-critical-slice',
    'release-memory-leak-budget',
    'release-open-handle-budget'
];
const reliabilityAttemptFixture = await createCleanAttemptEvidenceFixture({
    consumerId: 'release-reliability',
    membership: {
        lifecyclePhases: ['measurement', 'postcondition', 'precondition', 'reset'],
        scenarioIds: [...scenarioIds].sort()
    },
    schedulerRunId: 'receipt-run',
    sourceCommit: 'a'.repeat(40),
    worktreeFingerprint: `sha256:${'b'.repeat(64)}`,
    buildIdentity: `sha256:${'d'.repeat(64)}`
});
test.after(() => reliabilityAttemptFixture.cleanup());
const invocationId = 'receipt-invocation';
const runId = 'receipt-run';
const digest = (character) => `sha256:${character.repeat(64)}`;
const buildToolchain = {
    node: process.version,
    npm: 'fixture-npm',
    dotnet: 'fixture-dotnet',
    vite: 'fixture-vite',
    vitest: 'fixture-vitest',
    playwright: 'fixture-playwright',
    emsdk: 'fixture-emsdk'
};
const imageProducerLabels = {
    'io.fsusblog.build.fsusui-source': 'local-git-alias',
    'io.fsusblog.build.fsusui-commit': 'f'.repeat(40)
};
const repositoryCatalog = JSON.parse(fs.readFileSync(
    path.join(repositoryRoot, 'config/testing/release-reliability-scenario-catalog.json'),
    'utf8'
));
const physicalPolicyRelativePath =
    'config/testing/physical-execution-process-policy.json';
const repositoryPhysicalPolicyBytes = fs.readFileSync(
    path.join(repositoryRoot, physicalPolicyRelativePath)
);

function runtimeEnvironmentText({
    namespace,
    run = runId,
    postgres = 'fixture-postgres',
    redis = 'fixture-redis'
})
{
    return [
        `FSUSBLOG_TEST_RUN_ID=${run}`,
        `FSUSBLOG_TEST_NAMESPACE=${namespace}`,
        `FSUSBLOG_POSTGRES_CONTAINER_NAME=${postgres}`,
        `FSUSBLOG_REDIS_CONTAINER_NAME=${redis}`,
        'FSUSBLOG_DEBUG_BACKEND_PORT=24501',
        'FSUSBLOG_DEBUG_FRONTEND_PORT=26501',
        'FSUSBLOG_RELEASE_PREVIEW_PORT=28501',
        'FSUSBLOG_DEBUG_BACKEND_URL=http://127.0.0.1:24501',
        'FSUSBLOG_DEBUG_FRONTEND_URL=http://127.0.0.1:26501',
        'FSUSBLOG_RELEASE_PREVIEW_URL=http://127.0.0.1:28501',
        'ASPNETCORE_URLS=http://127.0.0.1:24501',
        'FSUSBLOG_DATA_ROOT=/host/run-bound/data',
        'PublicAot__SsrClientRoot=/host/run-bound/frontend/dist'
    ].join('\n') + '\n';
}

function containerRuntimeEnvironment({
    sourceCommit,
    sourceFingerprint,
    ...options
})
{
    const runtimeEnvironment = Object.fromEntries(
        runtimeEnvironmentText(options)
            .trimEnd()
            .split('\n')
            .map((entry) => entry.split(/=(.*)/su).slice(0, 2))
    );
    return Object.entries({
        ...projectQualifiedContainerEnvironment(runtimeEnvironment),
        ...releaseReliabilityAuditedContainerOverrides({
            runId: options.run ?? runId,
            namespace: options.namespace,
            sourceCommit,
            sourceFingerprint
        })
    }).map(([key, value]) => `${key}=${value}`);
}

function bytesDigest(bytes)
{
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function canonicalize(value)
{
    if (Array.isArray(value))
    {
        return value.map(canonicalize);
    }
    if (value !== null && typeof value === 'object')
    {
        return Object.fromEntries(
            Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])
        );
    }
    return value;
}

function fixtureCatalog()
{
    return {
        schema: 'fsusblog.release-reliability-scenario-catalog.v4',
        catalogScenarioCount: 7,
        canonicalScenarioIds: scenarioIds,
        identityTools: ['node'],
        childEnvironmentContract: repositoryCatalog.childEnvironmentContract,
        policyBindings: repositoryCatalog.policyBindings,
        actionRegistry:
            'config/testing/release-reliability-lifecycle-action-registry.json',
        lifecycleSchema:
            'fsusblog.release-reliability-lifecycle-action-receipt.v2',
        scenarios: scenarioIds.map((id) =>
        {
            const canonicalScenario = repositoryCatalog.scenarios.find(
                (scenario) => scenario.id === id
            );
            return {
                id,
                owner: 'fixture-owner',
                command: {
                    executable: 'node',
                    args: [],
                    env: canonicalScenario.command.env,
                    inheritEnv: canonicalScenario.command.inheritEnv,
                    cwd: '.'
                },
                qualification: canonicalScenario.qualification,
                resourceClass: 'fixture',
                identityTools: ['node'],
                isolation: {
                    exclusiveResources: ['fixture-state'],
                    countableResources: [],
                    lifecycle: {
                        preconditions: [`${id}-fixture-precondition`],
                        resetsBefore: [`${id}-fixture-reset-before`],
                        measurement: `${id}-fixture-measurement`,
                        postconditions: [`${id}-fixture-postcondition`],
                        resetsAfter: [`${id}-fixture-reset-after`]
                    },
                    outputs: [{ id: 'authoritative-evidence', path: `.tmp/evidence/${id}.json` }]
                },
                authoritativeEvidence: {
                    path: `.tmp/evidence/${id}.json`,
                    expectedSchema: {
                        required: ['status', 'sentinel', 'releaseReliability'],
                        passStatusValues: ['ok']
                    }
                }
            };
        })
    };
}

function fixtureLifecycleContracts(catalog = fixtureCatalog())
{
    const actions = [];
    for (const scenario of catalog.scenarios)
    {
        for (const [actionId, phase] of [
            [scenario.isolation.lifecycle.preconditions[0], 'precondition'],
            [scenario.isolation.lifecycle.resetsBefore[0], 'reset-before'],
            [scenario.isolation.lifecycle.measurement, 'measurement'],
            [scenario.isolation.lifecycle.postconditions[0], 'postcondition'],
            [scenario.isolation.lifecycle.resetsAfter[0], 'reset-after']
        ])
        {
            const measurement = phase === 'measurement';
            actions.push({
                actionId,
                scenarioId: scenario.id,
                phase,
                executable: measurement ? '$scenario.command' : 'node',
                args: measurement ? [] : ['fixture-action.mjs'],
                env: {},
                cwd: '.',
                expectedReceiptPath: measurement
                    ? scenario.authoritativeEvidence.path
                    : `.tmp/release-reliability/{invocationId}/lifecycle/{scenarioId}/{actionId}.json`,
                expectedReceiptSchema: measurement
                    ? scenario.authoritativeEvidence.expectedSchema.schema
                        ?? 'catalog-authoritative-evidence'
                    : catalog.lifecycleSchema,
                stateDomains: ['fixture-state'],
                passStatusValues: [measurement ? 'ok' : 'passed']
            });
        }
    }
    return {
        authorityBindings: fixtureLifecycleAuthorityBindings(),
        actions: new Map(actions.map((action) => [action.actionId, action]))
    };
}

function fixtureLifecycleRegistry(catalog = fixtureCatalog())
{
    const actions = [];
    for (const scenario of catalog.scenarios)
    {
        for (const [actionId, phase] of [
            [scenario.isolation.lifecycle.preconditions[0], 'precondition'],
            [scenario.isolation.lifecycle.resetsBefore[0], 'reset-before'],
            [scenario.isolation.lifecycle.measurement, 'measurement'],
            [scenario.isolation.lifecycle.postconditions[0], 'postcondition'],
            [scenario.isolation.lifecycle.resetsAfter[0], 'reset-after']
        ])
        {
            const measurement = phase === 'measurement';
            actions.push({
                actionId,
                scenarioId: scenario.id,
                phase,
                operation: measurement ? 'run-measurement' : 'observe-runtime',
                executable: measurement ? '$scenario.command' : 'node',
                args: measurement ? [] : ['fixture-action.mjs'],
                env: {},
                cwd: '.',
                expectedReceiptPath: measurement
                    ? scenario.authoritativeEvidence.path
                    : `.tmp/release-reliability/{invocationId}/lifecycle/{scenarioId}/{actionId}.json`,
                expectedReceiptSchema: measurement
                    ? scenario.authoritativeEvidence.expectedSchema.schema
                        ?? 'catalog-authoritative-evidence'
                    : catalog.lifecycleSchema,
                requiredFields: measurement
                    ? [...scenario.authoritativeEvidence.expectedSchema.required]
                        .sort()
                    : [
                        'actionId',
                        'contentDigest',
                        'finalObservation',
                        'finishedAt',
                        'invocationId',
                        'observations',
                        'operation',
                        'phase',
                        'runId',
                        'scenarioId',
                        'schema',
                        'startedAt',
                        'stateDomains',
                        'status'
                    ],
                passStatusValues: [measurement ? 'ok' : 'passed'],
                timeoutPolicy: { timeoutMs: 5000, terminateGraceMs: 10 },
                stateDomains: ['fixture-state'],
                safeAfterFailure: phase === 'reset-after'
            });
        }
    }
    return {
        schema: 'fsusblog.release-reliability-lifecycle-action-registry.v1',
        receiptSchema:
            'fsusblog.release-reliability-lifecycle-action-receipt.v2',
        scenarioCatalog:
            'config/testing/release-reliability-scenario-catalog.json',
        stateDomainRegistry:
            'config/testing/runtime-state-domain-registry.json',
        actions
    };
}

function childEnvironmentIdentity(catalog)
{
    return {
        status: 'complete',
        schema: catalog.childEnvironmentContract.schema,
        contentDigest: digestValue({
            contract: catalog.childEnvironmentContract,
            scenarios: catalog.scenarios.map((scenario) => ({
                id: scenario.id,
                inheritEnv: scenario.command.inheritEnv,
                env: scenario.command.env
            }))
        })
    };
}

function fixtureLifecycleAuthorityBindings()
{
    return {
        lifecycleActionRegistry: {
            status: 'complete',
            path: 'config/testing/release-reliability-lifecycle-action-registry.json',
            fileDigest: digest('b')
        },
        stateDomainRegistry: {
            status: 'complete',
            path: 'config/testing/runtime-state-domain-registry.json',
            fileDigest: digest('c')
        }
    };
}

function scenarioEnvironmentContract(catalog, scenario)
{
    const content = {
        schema: catalog.childEnvironmentContract.schema,
        scenarioId: scenario.id,
        requiredBaseKeys: catalog.childEnvironmentContract.requiredBaseKeys,
        optionalBaseKeys: catalog.childEnvironmentContract.optionalBaseKeys,
        requiredInheritedKeys: scenario.command.inheritEnv.required,
        optionalInheritedKeys: scenario.command.inheritEnv.optional,
        fixedEnvironment: scenario.command.env,
        internalKeys: catalog.childEnvironmentContract.internalKeys
    };
    return {
        schema: content.schema,
        scenarioId: scenario.id,
        contentDigest: digestValue(content)
    };
}

function completeIdentity(overrides = {})
{
    const sourceState = {
        commit: 'a'.repeat(40),
        worktreeFingerprint: digest('b'),
        dirtyPathCount: 0,
        hashedPathCount: 0
    };
    return sealDocument({
        schema: 'fsusblog.release-reliability-run-identity.v1',
        status: 'complete',
        invocationId,
        runId,
        sourceState,
        build: {
            status: 'complete',
            path: '.tmp/build/receipt.json',
            fileDigest: digest('c'),
            contentDigest: digest('d'),
            imageDigest: digest('e'),
            image: {
                kind: 'registry-repository-digest',
                reference: 'fixture/runtime:latest',
                repositoryDigest: `fixture/runtime@${digest('e')}`,
                imageDigest: digest('e'),
                revision: sourceState.commit,
                fsusuiSource: imageProducerLabels['io.fsusblog.build.fsusui-source'],
                fsusuiCommit: imageProducerLabels['io.fsusblog.build.fsusui-commit']
            },
            sourceState,
            producerRunId: runId,
            toolchain: buildToolchain
        },
        fixture: {
            status: 'complete',
            root: 'fixtures/runtime',
            namespace: 'receipt-fixture',
            config: { status: 'complete', path: 'fixtures/config.json', fileDigest: digest('1') },
            schema: { status: 'complete', path: 'fixtures/schema.sql', fileDigest: digest('2') },
            seed: { status: 'complete', path: 'fixtures/seed.json', fileDigest: digest('3') },
            auditRetentionPolicy: {
                status: 'complete',
                path: 'src/backend/Infrastructure/Audit/AuditRetentionCatalog.cs',
                fileDigest: digest('8')
            },
            topology: {
                status: 'complete',
                path: 'fixtures/topology.json',
                fileDigest: digest('4'),
                content: {
                    schema: 'fsusblog.release-reliability-runtime-topology.v1',
                    contentDigest: digest('0'),
                    postgres: {
                        instance: 'fixture-postgres',
                        version: '18',
                        configDigest: digest('a')
                    },
                    redis: {
                        instance: 'fixture-redis',
                        version: '8',
                        configDigest: digest('b')
                    },
                    auditRetentionPolicy: {
                        path: 'src/backend/Infrastructure/Audit/AuditRetentionCatalog.cs',
                        fileDigest: digest('8')
                    },
                    runtime: {
                        profile: 'fixture-runtime',
                        imageDigest: digest('e'),
                        backendContainer: { hostPid: 4242 }
                    }
                }
            }
        },
        machine: {
            status: 'complete',
            os: 'fixture-os',
            architecture: 'fixture-architecture',
            cpuModels: ['fixture-cpu'],
            cpuCount: 1,
            memoryBytes: 1,
            cgroup: {
                status: 'complete',
                version: 'v2',
                path: '/fixture',
                limits: {
                    'cpu.max': { path: 'fixture/cpu.max', value: 'max 100000' },
                    'cpuset.cpus.effective': { path: 'fixture/cpuset.cpus.effective', value: '0' },
                    'memory.max': { path: 'fixture/memory.max', value: 'max' },
                    'pids.max': { path: 'fixture/pids.max', value: 'max' }
                }
            },
            schedulerPolicy: { status: 'complete', path: 'fixtures/resources.json', fileDigest: digest('5') }
        },
        tools: [{ id: 'node', status: 'complete', executable: process.execPath, version: process.version }],
        policy: {
            catalog: {
                status: 'complete',
                path: 'config/testing/release-reliability-scenario-catalog.json',
                fileDigest: digest('6')
            },
            ...fixtureLifecycleAuthorityBindings(),
            threshold: { status: 'complete', path: 'tests/performance/perf-policy.yml', fileDigest: digest('7') },
            mutationSubset: {
                status: 'complete',
                path: 'config/testing/mutation/release-parity-subset.json',
                fileDigest: digest('9')
            },
            releaseResource: {
                status: 'complete',
                path: 'config/deployment/zero-downtime-resource-policy.json',
                fileDigest: digest('a')
            },
            physicalExecution: {
                status: 'complete',
                path: physicalPolicyRelativePath,
                fileDigest: bytesDigest(repositoryPhysicalPolicyBytes)
            },
            childEnvironment: childEnvironmentIdentity(fixtureCatalog()),
            executorSchema: 'fsusblog.release-reliability-scenario-result.v3',
            lifecycleSchema:
                'fsusblog.release-reliability-lifecycle-action-receipt.v2'
        },
        collectedAt: '2026-07-26T00:00:00.000Z',
        collectionErrors: [],
        ...overrides
    });
}

function identityReference(identity)
{
    return {
        path: `.tmp/release-reliability/${identity.invocationId}/identity.json`,
        contentDigest: identity.contentDigest
    };
}

function producerRecord(scenario, identity, processTreeReceipt = null)
{
    const commandToolId = path.basename(scenario.command.executable).replace(/\.exe$/iu, '');
    const executable = identity.tools.find((tool) => tool.id === commandToolId)?.executable;
    const logRoot =
        `.tmp/release-reliability/${identity.invocationId}/logs/lifecycle/${scenario.id}/${scenario.isolation.lifecycle.measurement}`;
    return {
        executable,
        args: scenario.command.args,
        env: scenario.command.env,
        environmentContract: scenarioEnvironmentContract(fixtureCatalog(), scenario),
        cwd: scenario.command.cwd,
        commandDigest: bytesDigest(Buffer.from(JSON.stringify(scenario.command))),
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdoutLog: `${logRoot}.stdout.log`,
        stderrLog: `${logRoot}.stderr.log`,
        processTreeReceipt
    };
}

function writeFixtureProcessTreeReceipt({
    repositoryRoot: fixtureRoot,
    identity,
    identityReference: reference,
    scenario,
    action,
    index
})
{
    const relative =
        `.tmp/release-reliability/${identity.invocationId}/process-trees/` +
        `${scenario.id}/${action.actionId}.json`;
    const policyBytes = fs.readFileSync(
        path.join(fixtureRoot, physicalPolicyRelativePath)
    );
    const terminalFence = {
        status: 'closed',
        sealedAt: `2026-07-26T00:00:0${index * 2 + 1}.000Z`,
        lateEvidenceAccepted: false
    };
    const fixturePid = 10_000 + index;
    const fixtureProcessGroup = {
        schema: 'fsusblog.process-group-or-job-identity.v1',
        platform: process.platform,
        kind: 'process-group',
        groupId: fixturePid,
        leaderPid: fixturePid,
        leaderProcessStartIdentity: `fixture-start-${fixturePid}`
    };
    const authority = process.platform === 'linux'
        ? {
            schema: 'fsusblog.physical-execution-authority.v1',
            platform: 'linux',
            kind: 'linux-cgroup-process-group',
            authorityId: `fixture-authority-${index}`,
            unitName: `fsusblog-physical-fixture-${index}`,
            controlGroup: `/user.slice/fixture-${index}.service`,
            supervisorPid: fixturePid - 1,
            processGroup: fixtureProcessGroup,
            killPolicy: 'control-group',
            established: true,
            attemptedUnitName: null
        }
        : process.platform === 'darwin'
            ? fixtureProcessGroup
            : {
                schema: 'fsusblog.process-group-or-job-identity.v1',
                platform: 'win32',
                kind: 'windows-job-object',
                jobName: `Local\\FsusBlogPhysicalExecution-fixture-${index}`,
                killPolicy: 'kill-on-close'
            };
    const declaredExecutable = action.executable === '$scenario.command'
        ? scenario.command.executable
        : action.executable;
    const declaredArgs = action.executable === '$scenario.command'
        ? scenario.command.args
        : action.args;
    const declaredEnvironment = action.executable === '$scenario.command'
        ? scenario.command.env
        : action.env;
    const declaredCwd = action.executable === '$scenario.command'
        ? scenario.command.cwd
        : action.cwd;
    const toolId = path.basename(declaredExecutable).replace(/\.exe$/iu, '');
    const executable = identity.tools.find((tool) => tool.id === toolId)?.executable
        ?? (declaredExecutable === 'node' ? process.execPath : declaredExecutable);
    const args = declaredArgs.map((argument) => argument
        .replaceAll('{actionId}', action.actionId)
        .replaceAll('{invocationId}', identity.invocationId)
        .replaceAll('{runId}', identity.runId)
        .replaceAll('{scenarioId}', scenario.id));
    const receipt = sealDocument({
        schema: 'fsusblog.release-reliability-process-tree-receipt.v1',
        status: 'passed',
        invocationId: identity.invocationId,
        runId: identity.runId,
        scenarioId: scenario.id,
        actionId: action.actionId,
        phase: action.phase,
        identity: reference,
        physicalPolicy: identity.policy.physicalExecution,
        command: {
            executable,
            args,
            cwd: declaredCwd,
            commandDigest: bytesDigest(Buffer.from(JSON.stringify({
                executable,
                args,
                env: declaredEnvironment,
                cwd: declaredCwd
            })))
        },
        startedAt: `2026-07-26T00:00:0${index * 2}.000Z`,
        finishedAt: `2026-07-26T00:00:0${index * 2 + 1}.000Z`,
        exitCode: 0,
        signal: null,
        timedOut: false,
        cancellation: null,
        reason: null,
        duplicateRequests: 0,
        processTree: {
            schema: 'fsusblog.physical-execution-process-tree.v1',
            platform: process.platform,
            policy: JSON.parse(policyBytes.toString('utf8')),
            authority,
            lifecycle: [
                'bounded-pipe-close',
                'post-observe-zero-members',
                'seal-completed-receipt'
            ],
            termination: [],
            postObservation: 'zero-members',
            processInventory: [{
                pid: fixturePid,
                startIdentity: `fixture-start-${fixturePid}`,
                ppid: null,
                pgid: process.platform === 'win32' ? null : fixturePid,
                jobId: process.platform === 'win32'
                    ? authority.jobName
                    : process.platform === 'linux' ? authority.unitName : null,
                executableDigest: bytesDigest(Buffer.from(
                    `fixture-executable-${fixturePid}`
                )),
                commandDigest: bytesDigest(Buffer.from(
                    `fixture-command-${fixturePid}`
                )),
                role: 'direct-child',
                observedAt: `2026-07-26T00:00:0${index * 2}.000Z`,
                exitCode: 0,
                signal: null
            }],
            logComplete: true,
            logTruncationReason: null,
            forcedPipeClose: false
        },
        logComplete: true,
        logTruncationReason: null,
        forcedPipeClose: false,
        terminalFence,
        failure: null
    });
    const absolute = path.join(fixtureRoot, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, `${JSON.stringify(receipt, null, 2)}\n`);
    return {
        reference: {
            path: relative,
            schema: receipt.schema,
            status: receipt.status,
            bytesDigest: bytesDigest(fs.readFileSync(absolute)),
            contentDigest: receipt.contentDigest,
            postObservation: 'zero-members',
            logComplete: true
        },
        terminalFence
    };
}

function scenarioResults(identity = completeIdentity())
{
    const reference = identityReference(identity);
    return scenarioIds.map((scenarioId) =>
    {
        const scenario = fixtureCatalog().scenarios.find((candidate) => candidate.id === scenarioId);
        const actionIds = [
            [scenario.isolation.lifecycle.preconditions[0], 'precondition'],
            [scenario.isolation.lifecycle.resetsBefore[0], 'reset-before'],
            [scenario.isolation.lifecycle.measurement, 'measurement'],
            [scenario.isolation.lifecycle.postconditions[0], 'postcondition'],
            [scenario.isolation.lifecycle.resetsAfter[0], 'reset-after']
        ];
        const contracts = fixtureLifecycleContracts();
        const actions = actionIds.map(([actionId, phase], index) =>
        {
            const measurement = phase === 'measurement';
            const finalObservation = measurement
                ? { status: 'verified-by-authoritative-schema' }
                : {
                    status: 'passed',
                    postStateDigest: digest(String(index + 1)),
                    failures: []
                };
            const receipt = {
                actionId,
                phase,
                path: measurement
                    ? scenario.authoritativeEvidence.path
                    : `.tmp/release-reliability/${identity.invocationId}/lifecycle/${scenarioId}/${actionId}.json`,
                schema: measurement
                    ? scenario.authoritativeEvidence.expectedSchema.schema
                        ?? 'catalog-authoritative-evidence'
                    : 'fsusblog.release-reliability-lifecycle-action-receipt.v2',
                status: measurement ? 'ok' : 'passed',
                stateDomains: ['fixture-state'],
                bytesDigest: digest(String(index + 1)),
                contentDigest: measurement ? null : digest(String(index + 2)),
                finalObservation
            };
            const processTree = writeFixtureProcessTreeReceipt({
                repositoryRoot,
                identity,
                identityReference: reference,
                scenario,
                action: contracts.actions.get(actionId),
                index
            });
            return {
                actionId,
                phase,
                status: 'passed',
                startedAt: `2026-07-26T00:00:0${index * 2}.000Z`,
                finishedAt: `2026-07-26T00:00:0${index * 2 + 1}.000Z`,
                durationMs: 1000,
                exitCode: 0,
                signal: null,
                timedOut: false,
                stdoutLog: `.tmp/logs/${actionId}.stdout.log`,
                stderrLog: `.tmp/logs/${actionId}.stderr.log`,
                receipt,
                processTreeReceipt: processTree.reference,
                terminalFence: processTree.terminalFence,
                finalObservation,
                failure: null
            };
        });
        const lifecycle = {
            actions,
            verifiedActionReceipts: actions.map((action) => action.receipt),
            resetPostObservation: actions[1].finalObservation,
            finalPostObservation: actions[4].finalObservation
        };
        const evidence = {
            path: `.tmp/evidence/${scenarioId}.json`,
            digest: digest('8'),
            schema: scenario.authoritativeEvidence.expectedSchema.schema
                ?? 'catalog-authoritative-evidence',
            status: 'ok'
        };
        return sealDocument({
            schema: 'fsusblog.release-reliability-scenario-result.v3',
            invocationId: identity.invocationId,
            runId: identity.runId,
            scenarioId,
            resultPath: `.tmp/release-reliability/${identity.invocationId}/scenario-results/${scenarioId}.json`,
            owner: 'fixture-owner',
            resourceClass: 'fixture',
            evidenceClass: 'correctness',
            qualificationEligible: true,
            status: 'passed',
            identity: reference,
            startedAt: '2026-07-26T00:00:00.000Z',
            finishedAt: '2026-07-26T00:00:10.000Z',
            producer: producerRecord(
                scenario,
                identity,
                actions.find((action) => action.phase === 'measurement')
                    .processTreeReceipt
            ),
            lifecycle,
            authoritativeEvidence: evidence,
            outputs: [{ id: 'authoritative-evidence', path: evidence.path, digest: evidence.digest }],
            firstFailure: null,
            cleanupFailures: [],
            terminalFence: actions.find(
                (action) => action.phase === 'measurement'
            ).terminalFence,
            cancellation: null,
            failure: null,
            recordedAt: '2026-07-26T00:00:11.000Z'
        });
    });
}

function qualifiedReceipt(identity = completeIdentity(), results = scenarioResults(identity), catalog = fixtureCatalog())
{
    const reference = identityReference(identity);
    const timeline = createTimeline({
        invocationId: identity.invocationId,
        runId: identity.runId,
        scenarioResults: results,
        identityReference: reference,
        createdAt: '2026-07-26T00:00:12.000Z'
    });
    const receipt = createCandidateReceipt({
        repositoryRoot,
        attemptEvidence: reliabilityAttemptFixture.attemptEvidence,
        expectedCandidate: reliabilityAttemptFixture.expectedCandidate,
        invocationId: identity.invocationId,
        runId: identity.runId,
        scenarioResults: results,
        identity,
        identityReference: reference,
        timeline,
        timelineReference: {
            path: `.tmp/release-reliability/${identity.invocationId}/timeline.json`,
            contentDigest: timeline.contentDigest
        },
        catalog,
        lifecycleContracts: fixtureLifecycleContracts(catalog),
        createdAt: '2026-07-26T00:00:12.000Z'
    });
    return { receipt, timeline };
}

behaviorTest('release-final-aggregate-contract', 'positive', 'aggregate stores only sealed result and original evidence references', () =>
{
    const { receipt } = qualifiedReceipt();
    assert.equal(receipt.status, 'candidate', receipt.failure);
    assert.equal(receipt.scenarios.length, 7);
    for (const reference of receipt.scenarios)
    {
        assert.deepEqual(Object.keys(reference), [
            'scenarioId',
            'resultPath',
            'resultContentDigest',
            'evidencePath',
            'evidenceDigest',
            'lifecycleActions',
            'resetPostObservation',
            'finalPostObservation',
            'firstFailure',
            'cleanupFailures'
        ]);
        assert.equal('source' in reference, false);
        assert.equal('isolation' in reference, false);
    }
});

test('identity precondition failures still produce sealed partial timeline and failed receipt', () =>
{
    const identity = sealDocument({
        ...completeIdentity(),
        status: 'unavailable',
        collectionErrors: ['fixture identity is incomplete']
    });
    const reference = identityReference(identity);
    const results = scenarioResults(identity).map((result) => sealDocument({
        ...result,
        status: 'failed',
        producer: {
            ...result.producer,
            exitCode: null
        },
        lifecycle: null,
        authoritativeEvidence: null,
        outputs: [],
        failure: 'run identity is incomplete; producer was not executed'
    }));
    const createdAt = '2026-07-26T00:00:12.000Z';
    const timeline = createTimeline({
        invocationId: identity.invocationId,
        runId: identity.runId,
        scenarioResults: results,
        identityReference: reference,
        createdAt
    });
    const receipt = createCandidateReceipt({
        repositoryRoot,
        attemptEvidence: reliabilityAttemptFixture.attemptEvidence,
        expectedCandidate: reliabilityAttemptFixture.expectedCandidate,
        invocationId: identity.invocationId,
        runId: identity.runId,
        scenarioResults: results,
        identity,
        identityReference: reference,
        timeline,
        timelineReference: {
            path: `.tmp/release-reliability/${identity.invocationId}/timeline.json`,
            contentDigest: timeline.contentDigest
        },
        catalog: fixtureCatalog(),
        createdAt
    });
    assert.equal(timeline.status, 'partial');
    assert.equal(timeline.scenarioResults.length, 7);
    assert.ok(timeline.scenarioResults.every((entry) => (
        entry.evidencePath === null && entry.evidenceDigest === null
    )));
    assert.equal(receipt.status, 'failed');
    assert.match(receipt.failure, /run identity is incomplete/u);
});

behaviorTest('release-final-aggregate-contract', 'negative', {
    title: 'missing, duplicate, extra, cancelled, partial, and cross-run results cannot qualify',
    invariantIds: ['release-final-shard-completeness']
}, () =>
{
    const catalog = fixtureCatalog();
    const identity = completeIdentity();
    const cases = [
        scenarioResults(identity).slice(1),
        [scenarioResults(identity)[0]],
        [...scenarioResults(identity), scenarioResults(identity)[0]],
        [...scenarioResults(identity).slice(0, -1), {
            ...scenarioResults(identity)[0],
            scenarioId: 'unknown-scenario'
        }],
        scenarioResults(identity).map((result, index) => index === 0
            ? sealDocument({ ...result, status: 'cancelled' })
            : result),
        scenarioResults(identity).map((result, index) => index === 0
            ? sealDocument({ ...result, status: 'partial' })
            : result),
        scenarioResults(identity).map((result, index) => index === 0
            ? sealDocument({ ...result, status: 'failed' })
            : result),
        scenarioResults(identity).map((result, index) => index === 0
            ? sealDocument({ ...result, runId: 'other-run' })
            : result),
        scenarioResults(identity).map((result, index) => index === 0
            ? sealDocument({ ...result, invocationId: 'other-invocation' })
            : result)
    ];
    for (const results of cases)
    {
        const { receipt } = qualifiedReceipt(identity, results, catalog);
        assert.equal(receipt.status, 'failed');
    }
});

test('diagnostic scenario results cannot be promoted into a candidate receipt', () =>
{
    const identity = completeIdentity();
    const results = scenarioResults(identity).map((result) => sealDocument({
        ...result,
        evidenceClass: 'diagnostic',
        qualificationEligible: false
    }));
    const { receipt } = qualifiedReceipt(identity, results);
    assert.equal(receipt.status, 'failed');
    assert.match(receipt.failure, /not qualification eligible correctness evidence/u);
});

test('tampered sealed result and fake lifecycle reference fail qualification', () =>
{
    const identity = completeIdentity();
    const tampered = scenarioResults(identity);
    tampered[0].authoritativeEvidence.path = '.tmp/evidence/reused.json';
    assert.equal(qualifiedReceipt(identity, tampered).receipt.status, 'failed');

    const fakeLifecycle = scenarioResults(identity);
    fakeLifecycle[0].lifecycle.verifiedActionReceipts[1].status = 'unverified';
    fakeLifecycle[0] = sealDocument(fakeLifecycle[0]);
    assert.equal(qualifiedReceipt(identity, fakeLifecycle).receipt.status, 'failed');
});

test('candidate rejects lifecycle authority drift after run identity collection', () =>
{
    const base = completeIdentity();
    const drifted = sealDocument({
        ...base,
        policy: {
            ...base.policy,
            lifecycleActionRegistry: {
                ...base.policy.lifecycleActionRegistry,
                fileDigest: digest('d')
            }
        }
    });
    const { receipt } = qualifiedReceipt(drifted, scenarioResults(drifted));
    assert.equal(receipt.status, 'failed');
    assert.match(receipt.failure, /policy identity is incomplete/u);
});

test('missing tool and unavailable cgroup identities cannot qualify', () =>
{
    const missingToolBase = completeIdentity();
    const missingTool = sealDocument({
        ...missingToolBase,
        tools: [{ ...missingToolBase.tools[0], status: 'unavailable' }]
    });
    assert.equal(qualifiedReceipt(missingTool, scenarioResults(missingTool)).receipt.status, 'failed');

    const missingCgroupBase = completeIdentity();
    const missingCgroup = sealDocument({
        ...missingCgroupBase,
        machine: {
            ...missingCgroupBase.machine,
            cgroup: { status: 'unavailable', version: 'v2', limits: {} }
        }
    });
    assert.equal(qualifiedReceipt(missingCgroup, scenarioResults(missingCgroup)).receipt.status, 'failed');
});

test('source, build image, and build producer run must exactly equal run identity', () =>
{
    const sourceMismatchBase = completeIdentity();
    const sourceMismatch = sealDocument({
        ...sourceMismatchBase,
        build: {
            ...sourceMismatchBase.build,
            sourceState: { ...sourceMismatchBase.sourceState, commit: 'f'.repeat(40) }
        }
    });
    assert.equal(qualifiedReceipt(sourceMismatch, scenarioResults(sourceMismatch)).receipt.status, 'failed');

    const imageMismatchBase = completeIdentity();
    const imageMismatch = sealDocument({
        ...imageMismatchBase,
        build: { ...imageMismatchBase.build, imageDigest: digest('f') }
    });
    assert.equal(qualifiedReceipt(imageMismatch, scenarioResults(imageMismatch)).receipt.status, 'failed');

    const runMismatchBase = completeIdentity();
    const runMismatch = sealDocument({
        ...runMismatchBase,
        build: { ...runMismatchBase.build, producerRunId: 'other-run' }
    });
    assert.equal(qualifiedReceipt(runMismatch, scenarioResults(runMismatch)).receipt.status, 'failed');
});

test('canonical worktree fingerprint binds dirty and untracked bytes at the same paths', async (context) =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-worktree-fingerprint-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'receipt@example.invalid'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Receipt Test'], { cwd: root });
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'base\n');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'first dirty bytes\n');
    const first = await snapshotGitWorktree(root);
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'second dirty bytes\n');
    const second = await snapshotGitWorktree(root);
    assert.deepEqual(Object.keys(first.entries), ['tracked.txt']);
    assert.deepEqual(Object.keys(second.entries), ['tracked.txt']);
    assert.notEqual(first.fingerprint, second.fingerprint);

    fs.writeFileSync(path.join(root, 'tracked.txt'), 'second dirty bytes\n');
    fs.writeFileSync(path.join(root, 'untracked.txt'), 'first untracked bytes\n');
    const firstUntracked = await snapshotGitWorktree(root);
    fs.writeFileSync(path.join(root, 'untracked.txt'), 'second untracked bytes\n');
    const secondUntracked = await snapshotGitWorktree(root);
    assert.deepEqual(Object.keys(firstUntracked.entries).sort(), ['tracked.txt', 'untracked.txt']);
    assert.deepEqual(Object.keys(secondUntracked.entries).sort(), ['tracked.txt', 'untracked.txt']);
    assert.notEqual(firstUntracked.fingerprint, secondUntracked.fingerprint);
});

test('identity collector consumes the canonical production build receipt without inventing an image field', async (context) =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-identity-collector-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const catalog = fixtureCatalog();
    catalog.identityTools = ['lsof', 'node'];
    for (const scenario of catalog.scenarios)
    {
        scenario.identityTools = ['lsof', 'node'];
    }
    const trackedFiles = {
        '.gitignore': '.tmp/\n',
        'config/testing/release-reliability-scenario-catalog.json': `${JSON.stringify(catalog, null, 2)}\n`,
        'config/testing/release-reliability-lifecycle-action-registry.json':
            `${JSON.stringify(fixtureLifecycleRegistry(catalog), null, 2)}\n`,
        'config/testing/runtime-state-domain-registry.json':
            `${JSON.stringify({
                schema: 'fsusblog.runtime-state-domain-registry.v1',
                domains: ['fixture-state']
            }, null, 2)}\n`,
        'config/schemas/release-reliability-lifecycle-action-registry.schema.json':
            fs.readFileSync(
                path.join(
                    repositoryRoot,
                    'config/schemas/release-reliability-lifecycle-action-registry.schema.json'
                ),
                'utf8'
            ),
        'tests/performance/perf-policy.yml': fs.readFileSync(
            path.join(repositoryRoot, 'tests/performance/perf-policy.yml'),
            'utf8'
        ),
        'config/testing/mutation/release-parity-subset.json': fs.readFileSync(
            path.join(repositoryRoot, 'config/testing/mutation/release-parity-subset.json'),
            'utf8'
        ),
        'config/deployment/zero-downtime-resource-policy.json': fs.readFileSync(
            path.join(repositoryRoot, 'config/deployment/zero-downtime-resource-policy.json'),
            'utf8'
        ),
        [physicalPolicyRelativePath]:
            repositoryPhysicalPolicyBytes,
        'fixtures/config.env': runtimeEnvironmentText({ namespace: 'collector-fixture' }),
        'fixtures/schema.sql': 'CREATE TABLE fixture(id integer);\n',
        'fixtures/seed.json': '{"seed":[1]}\n',
        'fixtures/resources.json': '{"cpu":"exclusive"}\n',
        'fixtures/runtime/.keep': 'fixture\n',
        'src/backend/Infrastructure/Audit/AuditRetentionCatalog.cs': 'public static class AuditRetentionCatalog {}\n'
    };
    for (const [relative, contents] of Object.entries(trackedFiles))
    {
        const file = path.join(root, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, contents);
    }
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'collector@example.invalid'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Collector Test'], { cwd: root });
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const snapshot = await snapshotGitWorktree(root);
    const artifactRoot = path.join(root, '.tmp/ci-production-build');
    fs.mkdirSync(path.join(artifactRoot, 'payload/backend'), { recursive: true });
    fs.writeFileSync(path.join(artifactRoot, 'payload/backend/FsusBlog.Server.dll'), 'fixture');
    const build = createProductionBuildReceipt({
        root,
        artifactRoot,
        sourceState: { commit, worktreeFingerprint: `sha256:${snapshot.fingerprint}` },
        producer: { runId, runAttempt: 1, job: 'production-build-artifacts' },
        toolchain: collectProductionToolchain({ root }),
        inputPaths: ['config/testing/release-reliability-scenario-catalog.json'],
        domains: [{ name: 'backend-runtime', path: 'payload/backend' }]
    });
    assert.equal('imageDigest' in build.build, false);
    const fakeToolDirectory = path.join(root, '.tmp/tools');
    const fakeLsof = path.join(fakeToolDirectory, 'lsof');
    fs.mkdirSync(fakeToolDirectory, { recursive: true });
    fs.writeFileSync(fakeLsof, '#!/bin/sh\nprintf "lsof version information:\\n    revision: 4.95.0\\n"\n');
    fs.chmodSync(fakeLsof, 0o755);
    const collectorDocker = path.join(fakeToolDirectory, 'docker');
    const collectorDockerState = path.join(root, '.tmp/collector-docker-state.json');
    const collectorEnvironment = containerRuntimeEnvironment({
        namespace: 'collector-fixture',
        sourceCommit: commit,
        sourceFingerprint: snapshot.fingerprint
    });
    const collectorProcess = {
        pid: 1, processGroupId: 1, sessionId: 1, startTimeTicks: '123',
        executable: '/app/FsusBlog.Server', commandLine: ['/app/FsusBlog.Server'],
        workingDirectory: '/app',
        environment: Object.fromEntries(collectorEnvironment.map((entry) => entry.split(/=(.*)/su).slice(0, 2)))
    };
    const collectorHealthcheck = {
        Test: ['CMD-SHELL', 'curl -fsS http://127.0.0.1:8080/health/live'],
        Interval: 30_000_000_000,
        Timeout: 5_000_000_000,
        StartPeriod: 45_000_000_000,
        Retries: 3
    };
    const collectorLabels = {
        'io.fsusblog.test.run-id': runId,
        'io.fsusblog.test.namespace': 'collector-fixture'
    };
    const collectorNetworkName = 'collector-fixture-network';
    const collectorNetworkId = 'collector-fixture-network-id';
    const collectorState = {
        image: {
            Id: digest('9'),
            Config: {
                Env: [],
                Healthcheck: structuredClone(collectorHealthcheck),
                Labels: { 'org.opencontainers.image.revision': commit, ...imageProducerLabels }
            },
            RootFS: { Layers: [digest('a'), digest('b')] }
        },
        process: collectorProcess,
        'fixture-backend': {
            Id: 'fixture-backend-id',
            Image: digest('9'),
            Path: '/app/FsusBlog.Server',
            Args: [],
            State: {
                Running: true,
                Pid: 4242,
                StartedAt: '2026-07-26T00:00:00Z',
                Health: { Status: 'healthy' }
            },
            Config: {
                Image: 'fixture/runtime:immutable',
                Env: collectorEnvironment,
                ExposedPorts: { '8080/tcp': {} },
                Healthcheck: structuredClone(collectorHealthcheck),
                Labels: { ...collectorLabels }
            },
            HostConfig: {
                PortBindings: {
                    '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '24501' }]
                }
            },
            NetworkSettings: {
                Networks: {
                    [collectorNetworkName]: {
                        Aliases: ['backend'],
                        IPAddress: '172.29.0.4',
                        NetworkID: collectorNetworkId
                    }
                },
                Ports: {
                    '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '24501' }]
                }
            }
        }
    };
    for (const name of ['fixture-postgres', 'fixture-redis'])
    {
        const alias = name === 'fixture-postgres' ? 'postgres' : 'redis';
        collectorState[name] = {
            Id: `${name}-id`,
            Image: digest('d'),
            State: { Running: true },
            Config: { Image: `${name}:fixture`, Labels: { ...collectorLabels } },
            NetworkSettings: {
                Networks: {
                    [collectorNetworkName]: {
                        Aliases: [alias],
                        IPAddress: alias === 'postgres' ? '172.29.0.2' : '172.29.0.3',
                        NetworkID: collectorNetworkId
                    }
                }
            }
        };
    }
    collectorState[collectorNetworkName] = {
        Id: collectorNetworkId,
        Name: collectorNetworkName,
        Driver: 'bridge',
        Labels: { ...collectorLabels },
        Containers: Object.fromEntries(
            ['fixture-backend', 'fixture-postgres', 'fixture-redis'].map((name) => [
                collectorState[name].Id,
                { Name: name }
            ])
        )
    };
    writeJson(collectorDockerState, collectorState);
    fs.writeFileSync(collectorDocker, String.raw`#!/usr/bin/env node
const fs = require('node:fs'); const state = JSON.parse(fs.readFileSync(process.env.FSUSBLOG_COLLECTOR_DOCKER_STATE, 'utf8'));
if (process.argv[2] === 'image') { process.stdout.write(JSON.stringify([state.image])); process.exit(0); }
if (process.argv[2] === 'network' && process.argv[3] === 'inspect') { const value = state[process.argv.at(-1)]; if (!value) process.exit(1); process.stdout.write(JSON.stringify([value])); process.exit(0); }
if (process.argv[2] === 'exec') { const command = process.argv.at(-1); const value = state.process; if (command.includes('/proc/1/stat')) { const tail = ['S', '0', String(value.processGroupId), String(value.sessionId), ...Array(15).fill('0'), String(value.startTimeTicks)]; process.stdout.write('1 (FsusBlog.Server) ' + tail.join(' ') + '\n'); } else if (command.includes('/proc/1/environ')) process.stdout.write(Object.entries(value.environment).map(([key, item]) => key + '=' + item).join('\n') + '\n'); else if (command.includes('/proc/1/exe')) process.stdout.write(value.executable + '\n'); else if (command.includes('/proc/1/cmdline')) process.stdout.write(value.commandLine.join('\n') + '\n'); else if (command.includes('/proc/1/cwd')) process.stdout.write(value.workingDirectory + '\n'); else process.exit(1); process.exit(0); }
const value = state[process.argv.at(-1)]; if (process.argv[2] !== 'inspect' || !value) process.exit(1); process.stdout.write(JSON.stringify([value]));
`);
    fs.chmodSync(collectorDocker, 0o755);
    const collectedTopology = '.tmp/collector-topology.json';
    const collectorResult = spawnSync(process.execPath, [path.join(repositoryRoot, 'tools/test/collect-release-reliability-fixture.mjs'),
        '--root', root, '--run-id', runId, '--namespace', 'collector-fixture', '--fixture-root', 'fixtures/runtime',
        '--config', 'fixtures/config.env', '--schema', 'fixtures/schema.sql', '--seed', 'fixtures/seed.json',
        '--audit-retention-policy', 'src/backend/Infrastructure/Audit/AuditRetentionCatalog.cs',
        '--postgres', 'fixture-postgres', '--redis', 'fixture-redis', '--backend-container', 'fixture-backend',
        '--network', collectorNetworkName,
        '--source-commit', commit, '--source-fingerprint', snapshot.fingerprint,
        '--runtime-image', 'fixture/runtime:immutable', '--image-digest', digest('9'), '--out', collectedTopology
    ], { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${fakeToolDirectory}${path.delimiter}${process.env.PATH ?? ''}`, FSUSBLOG_COLLECTOR_DOCKER_STATE: collectorDockerState } });
    assert.equal(collectorResult.status, 0, collectorResult.stderr);
    const fixtureAuthority = {
        schema: 'fsusblog.release-reliability-fixture-authority.v1', status: 'complete', runId,
        namespace: 'collector-fixture', root: 'fixtures/runtime',
        config: { path: 'fixtures/config.env', fileDigest: bytesDigest(fs.readFileSync(path.join(root, 'fixtures/config.env'))) },
        schemaFile: { path: 'fixtures/schema.sql', fileDigest: bytesDigest(fs.readFileSync(path.join(root, 'fixtures/schema.sql'))) },
        seed: { path: 'fixtures/seed.json', fileDigest: bytesDigest(fs.readFileSync(path.join(root, 'fixtures/seed.json'))) },
        auditRetentionPolicy: {
            path: 'src/backend/Infrastructure/Audit/AuditRetentionCatalog.cs',
            fileDigest: bytesDigest(fs.readFileSync(path.join(
                root,
                'src/backend/Infrastructure/Audit/AuditRetentionCatalog.cs'
            )))
        },
        topology: { postgres: { id: 'pg' }, redis: { id: 'redis' }, backend: { pid: 1, imageDigest: digest('9') } }, contentDigest: null
    };
    fixtureAuthority.contentDigest = digestValue(fixtureAuthority);
    writeJson(path.join(root, '.tmp/fixture-authority.json'), fixtureAuthority);

    const identity = await collectRunIdentity({
        repositoryRoot: root,
        catalog,
        invocationId,
        runId,
        env: {
            FSUSBLOG_CI_PRODUCTION_ARTIFACT_ROOT: '.tmp/ci-production-build',
            FSUSBLOG_RELEASE_RUNTIME_IMAGE: 'fixture/runtime:latest',
            FSUSBLOG_RELEASE_FIXTURE_AUTHORITY: collectedTopology,
            FSUSBLOG_TEST_FIXTURE_ROOT: 'fixtures/runtime',
            FSUSBLOG_TEST_NAMESPACE: 'collector-fixture',
            FSUSBLOG_TEST_FIXTURE_CONFIG: 'fixtures/config.env',
            FSUSBLOG_TEST_FIXTURE_SCHEMA: 'fixtures/schema.sql',
            FSUSBLOG_TEST_FIXTURE_SEED: 'fixtures/seed.json',
            FSUSBLOG_TEST_FIXTURE_AUDIT_RETENTION_POLICY: 'src/backend/Infrastructure/Audit/AuditRetentionCatalog.cs',
            FSUSBLOG_TEST_RUNTIME_TOPOLOGY: collectedTopology,
            FSUSBLOG_RELEASE_RESOURCE_POLICY: 'fixtures/resources.json',
            PATH: `${fakeToolDirectory}${path.delimiter}${process.env.PATH ?? ''}`
        },
        inspectImage: () => ({
            Id: digest('9'),
            Config: { Labels: { 'org.opencontainers.image.revision': commit, ...imageProducerLabels } },
            RootFS: { Layers: [digest('a'), digest('b')] },
            RepoDigests: []
        }),
        now: () => '2026-07-26T00:00:00.000Z'
    });
    assert.equal(identity.status, 'complete', identity.collectionErrors.join('\n'));
    assert.deepEqual(identity.collectionErrors, []);
    assert.equal(identity.build.contentDigest, build.contentDigest);
    assert.equal(identity.build.imageDigest, digest('9'));
    assert.equal(identity.build.image.kind, 'local-docker-image-id');
    assert.equal(identity.build.image.revision, commit);
    assert.equal(identity.build.image.fsusuiSource, 'local-git-alias');
    assert.equal(identity.build.image.fsusuiCommit, 'f'.repeat(40));
    assert.deepEqual(identity.build.image.layers, [digest('a'), digest('b')]);
    assert.equal('receiptImageDigest' in identity.build, false);
    assert.equal(identity.fixture.topology.content.runtime.imageDigest, digest('9'));
    const lsof = identity.tools.find((tool) => tool.id === 'lsof');
    assert.equal(lsof.status, 'complete');
    assert.equal(lsof.executable, fs.realpathSync(fakeLsof));
    assert.match(lsof.version, /^\d+\.\d+/u);
});

test('source and policy collector failures produce sealed unavailable identity instead of starting optimistically', async (context) =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-unavailable-collector-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const identity = await collectRunIdentity({
        repositoryRoot: root,
        catalog: fixtureCatalog(),
        invocationId,
        runId,
        env: {},
        now: () => '2026-07-26T00:00:00.000Z'
    });
    assert.equal(identity.status, 'unavailable');
    assert.equal(identity.contentDigest, digestValue(identity));
    assert.equal(identity.sourceState.commit, null);
    assert.ok(identity.collectionErrors.some((error) => error.includes('source identity collection failed')));
    assert.equal(identity.policy.catalog.status, 'unavailable');
});

test('collector rejects caller-selected receipt paths and uninspected image digests', async (context) =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-untrusted-release-input-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const identity = await collectRunIdentity({
        repositoryRoot: root,
        catalog: fixtureCatalog(),
        invocationId,
        runId,
        env: {
            FSUSBLOG_RELEASE_BUILD_RECEIPT: 'any/receipt.json',
            FSUSBLOG_RELEASE_IMAGE_DIGEST: digest('a'),
            FSUSBLOG_CI_PRODUCTION_ARTIFACT_ROOT: 'any',
            FSUSBLOG_RELEASE_RUNTIME_IMAGE: 'fixture/runtime:latest'
        },
        inspectImage: () => ({ RepoDigests: [] }),
        now: () => '2026-07-26T00:00:00.000Z'
    });
    assert.equal(identity.status, 'unavailable');
    assert.ok(identity.collectionErrors.some((error) => error.includes('forbidden')));
    assert.ok(identity.collectionErrors.some((error) => error.includes('production build artifact root')));
});

function writeJson(file, document)
{
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`);
}

function currentCgroup()
{
    const membership = fs.readFileSync('/proc/self/cgroup', 'utf8')
        .split(/\r?\n/u)
        .map((line) => line.match(/^0::(\/.*)$/u)?.[1] ?? null)
        .find(Boolean);
    if (!membership || membership.includes('..'))
    {
        return { status: 'unavailable', version: 'v2', path: null, limits: {} };
    }
    const cgroupRoot = path.join('/sys/fs/cgroup', membership.replace(/^\//u, ''));
    const limits = {};
    for (const name of ['cpu.max', 'cpuset.cpus.effective', 'memory.max', 'pids.max'])
    {
        let cursor = cgroupRoot;
        let file = null;
        while (cursor.startsWith('/sys/fs/cgroup'))
        {
            const candidate = path.join(cursor, name);
            if (fs.existsSync(candidate) && fs.lstatSync(candidate).isFile())
            {
                file = candidate;
                break;
            }
            if (cursor === '/sys/fs/cgroup')
            {
                break;
            }
            cursor = path.dirname(cursor);
        }
        if (file === null)
        {
            return { status: 'unavailable', version: 'v2', path: membership, limits };
        }
        limits[name] = {
            path: path.relative('/sys/fs/cgroup', file).replaceAll(path.sep, '/'),
            value: fs.readFileSync(file, 'utf8').trim()
        };
    }
    return { status: 'complete', version: 'v2', path: membership, limits };
}

function passingVerifierEvidence(root, scenario, releaseReliability)
{
    const qualification = scenario.qualification;
    const common = { status: 'ok', sentinel: 'current', releaseReliability };
    if (qualification.kind === 'soak')
    {
        return {
            ...common,
            mode: qualification.mode,
            durationSeconds: qualification.durationSeconds,
            executionMode: qualification.executionMode,
            countsAsReleaseFinal: qualification.countsAsReleaseFinal,
            sampling: {
                intervalMs: qualification.intervalMs,
                requestsPerProbe: qualification.requestsPerProbe,
                concurrency: qualification.concurrency,
                probeCount: 1
            },
            sampleCount: qualification.requestsPerProbe,
            probes: [{
                status: 'ok',
                sampleCount: qualification.requestsPerProbe,
                concurrency: qualification.concurrency
            }]
        };
    }
    if (qualification.kind === 'load-profile')
    {
        const policyBytes = fs.readFileSync(path.join(root, qualification.policy));
        const routeCatalog = JSON.parse(fs.readFileSync(
            path.join(root, 'config/testing/runtime-http-route-contracts.json'),
            'utf8'
        ));
        // Synthetic verifier unit inputs, never runtime or qualification evidence.
        const routes = routeCatalog.producers['runtime-load-soak'];
        const plan = createLoadExecutionPlan(qualification.declared, routes);
        const samples = [];
        const dispatches = [];
        const expectedRequests = [];
        const workers = Array.from({ length: plan.concurrency }, (_, index) => ({
            workerId: `worker-${index}`, readyMonotonicMs: 99,
            dispatched: plan.rounds + 1, completed: plan.rounds + 1
        }));
        for (let sequence = 0; sequence <= plan.rounds; sequence += 1)
        {
            for (const worker of workers)
            {
                const ordinal = dispatches.length;
                const routeId = routes[ordinal % routes.length];
                const route = routeCatalog.routes.find((entry) => entry.routeId === routeId);
                const membership = { sampleId: `${worker.workerId}:${sequence}`,
                    workerId: worker.workerId, sequence, path: route.pathTemplate };
                expectedRequests.push(membership);
                const startedMonotonicMs = 100 + sequence * 2;
                dispatches.push({ ordinal, routeId, ...membership, startedMonotonicMs });
                samples.push({ ...membership, startedMonotonicMs,
                    finishedMonotonicMs: startedMonotonicMs + 1, durationMs: 1,
                    outcome: 'success', httpStatus: 200, bytes: 32,
                    contentType: 'application/octet-stream', frameType: route.expectedAedsFrameType,
                    errorKind: null, errorCode: null, errorDigest: null });
            }
        }
        const calculated = calculateLoadSampleMetrics({ samples, expectedRequests, durationMs: plan.durationMs + 5 });
        const resources = normalizeLoadResourceObservability();
        const metrics = { rps: calculated.rps, p50Ms: 1, p95Ms: 1, p99Ms: 1,
            maxLatencyMs: 1, errorRate: 0, timeoutRate: 0, ...resources };
        const check = (metric, operator, threshold) => ({ metric, actual: metrics[metric], operator, threshold, status: 'pass' });
        const identity = { binding: releaseReliability,
            target: { status: 'ok', kind: 'docker-container', containerId: 'a'.repeat(64), pid: 1 } };
        const evidence = {
            ...common, schema: 'fsusblog.release-load-profile.v2', evidenceClass: 'correctness',
            profile: qualification.profile, profileName: qualification.profile,
            policy: { file: qualification.policy, fileDigest: bytesDigest(policyBytes), version: 'fsusblog-perf-policy-v1' },
            policyDigest: bytesDigest(policyBytes), executionPlanDigest: plan.contentDigest,
            declared: qualification.declared, effective: qualification.declared,
            thresholds: qualification.thresholds, overrideSource: 'env',
            overrideSources: { concurrency: 'env:FSUSBLOG_LOAD_PROFILE_CONCURRENCY',
                rounds: 'env:FSUSBLOG_LOAD_PROFILE_ROUNDS', durationMs: 'env:FSUSBLOG_LOAD_PROFILE_DURATION_MS' },
            sampling: { totalRequests: samples.length, minimumCompletedRequests: plan.minimumCompletedRequests,
                concurrency: plan.concurrency, rounds: plan.rounds, durationMs: plan.durationMs, routeIds: routes },
            thresholdEvaluation: { status: 'pass', checks: [
                check('p95Ms', '<=', qualification.thresholds.maxP95Ms),
                check('p99Ms', '<=', qualification.thresholds.maxP99Ms),
                check('errorRate', '<=', qualification.thresholds.maxErrorRate),
                check('timeoutRate', '<=', qualification.thresholds.maxTimeoutRate),
                check('rps', '>=', qualification.thresholds.minRps) ] },
            metrics, resourceObservability: resources,
            resourceSamples: [99, 100 + plan.durationMs + 5].map((observedMonotonicMs, index) => ({
                phase: index === 0 ? 'start' : 'end', observedMonotonicMs, status: 'unavailable', reason: 'unit control, not a resource observation' })),
            sampleCount: samples.length, samplesDigest: calculated.samplesDigest,
            outcomeCounts: calculated.outcomeCounts, statusDistribution: calculated.statusDistribution,
            pathDistribution: routes.map((routeId) => ({ routeId,
                path: routeCatalog.routes.find((entry) => entry.routeId === routeId).pathTemplate,
                planned: dispatches.filter((d) => d.routeId === routeId).length,
                actual: dispatches.filter((d) => d.routeId === routeId).length })),
            runtime: {
                status: 'ok', plan, dispatches, samples, expectedRequests, calculated,
                generatorBudget: { maxDispatchedRequests: plan.maximumDispatchedRequests },
                identityBefore: identity, identityAfter: identity, routeFailures: [], failureReasons: [],
                sampleCount: samples.length, concurrency: plan.concurrency,
                routeContractDigest: bytesDigest(Buffer.from(JSON.stringify(routeCatalog))),
                window: { measurementStart: 100, deadline: 100 + plan.durationMs,
                    dispatchClosed: 100 + plan.durationMs, finishedMonotonicMs: 100 + plan.durationMs + 5,
                    resourceSamplingStartedMonotonicMs: 99, resourceSamplingFinishedMonotonicMs: 100 + plan.durationMs + 6,
                    identityVerificationStartedMonotonicMs: 100 + plan.durationMs + 6,
                    identityVerificationFinishedMonotonicMs: 100 + plan.durationMs + 7,
                    observedActiveWindowMs: plan.durationMs, totalElapsedMs: plan.durationMs + 5,
                    drainMs: 5, workerCount: plan.concurrency, peakInFlight: plan.concurrency, workers }
            }
        };
        return { ...evidence, contentDigest: digestValue(evidence) };
    }
    if (qualification.kind === 'data-scale')
    {
        const sampling = {
            requests: qualification.requests,
            concurrency: qualification.concurrency,
            routeCount: 3
        };
        return {
            ...common,
            tier: qualification.tier,
            expectedSeed: qualification.expectedSeed,
            sampling,
            cleanup: { status: 'ok' },
            observed: {
                status: 'ok',
                tier: qualification.tier,
                sampling,
                runtime: {
                    sampleCount: qualification.requests,
                    concurrency: qualification.concurrency
                },
                observed: qualification.expectedSeed
            }
        };
    }
    if (qualification.kind === 'release-resource-budget')
    {
        const policyBytes = fs.readFileSync(path.join(root, qualification.policy));
        const metric = {
            name: qualification.metric,
            threshold: qualification.threshold,
            thresholdKind: qualification.thresholdKind,
            thresholdOperator: qualification.thresholdOperator,
            thresholdField: 'delta',
            delta: 0,
            status: 'ok'
        };
        return {
            ...common,
            mode: qualification.mode,
            policy: {
                file: qualification.policy,
                fileDigest: bytesDigest(policyBytes)
            },
            sampling: {
                requests: qualification.requests,
                concurrency: qualification.concurrency,
                routeCount: 3
            },
            metrics: [metric],
            thresholdEvaluation: {
                status: 'pass',
                checks: [{
                    metric: qualification.metric,
                    actual: 0,
                    operator: qualification.thresholdOperator,
                    threshold: qualification.threshold,
                    status: 'pass'
                }]
            },
            runtime: {
                sampleCount: qualification.requests,
                concurrency: qualification.concurrency
            }
        };
    }
    if (qualification.kind === 'mutation-release-parity')
    {
        const policyFile = path.join(root, qualification.policy);
        const policyBytes = fs.readFileSync(policyFile);
        const policy = JSON.parse(policyBytes);
        const executedMutantIds = policy.subset.map((_, index) => `mutant-${index + 1}`);
        const resolvedSubset = policy.subset.map((entry, index) => ({
            ...entry,
            mutantId: executedMutantIds[index]
        }));
        const inventoryDigest = digest('b');
        const configDigest = digest('c');
        const releaseParityPath = `.tmp/mutation/backend-critical/release-parity/${
            releaseReliability.runId
        }/release-parity-receipt.json`;
        const releaseParity = {
            schema: 'fsusblog.release-mutation-parity-receipt.v1',
            evidenceClass: 'release-artifact',
            runId: releaseReliability.runId,
            sourceAuthority: { inventoryDigest, configDigest },
            resolvedSubset,
            resolvedSubsetDigest: bytesDigest(Buffer.from(JSON.stringify(resolvedSubset)))
        };
        writeJson(path.join(root, releaseParityPath), releaseParity);
        const releaseParityBytes = fs.readFileSync(path.join(root, releaseParityPath));
        return {
            ...common,
            tierId: qualification.tierId,
            sliceId: qualification.sliceId,
            config: { sha256: configDigest },
            inventoryDigest,
            plannedMutantIds: executedMutantIds,
            executedMutantIds,
            releaseQualification: {
                schema: 'fsusblog.release-mutation-qualification.v1',
                status: 'complete',
                tierId: qualification.tierId,
                sliceId: qualification.sliceId,
                releaseParity: true,
                policy: {
                    path: qualification.policy,
                    fileDigest: bytesDigest(policyBytes),
                    subsetDigest: policy.subsetDigest
                },
                releaseParityReceipt: {
                    path: releaseParityPath,
                    fileDigest: bytesDigest(releaseParityBytes),
                    resolvedSubsetDigest: releaseParity.resolvedSubsetDigest
                },
                sourceAuthority: { inventoryDigest, configDigest },
                plannedMutantIds: executedMutantIds,
                executedMutantIds
            }
        };
    }
    throw new Error(`unsupported fixture qualification: ${qualification.kind}`);
}

async function createCliFixture(context)
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-receipt-verifier-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const catalog = fixtureCatalog();
    const fixtureNamespace = 'verifier-fixture';
    const fixtureNetworkName = 'verifier-fixture-network';
    const fixtureNetworkId = 'verifier-fixture-network-id';
    const fixtureLabels = {
        'io.fsusblog.test.run-id': runId,
        'io.fsusblog.test.namespace': fixtureNamespace
    };
    const fixtureHealthcheck = {
        Test: ['CMD-SHELL', 'curl -fsS http://127.0.0.1:8080/health/live'],
        Interval: 30_000_000_000,
        Timeout: 5_000_000_000,
        StartPeriod: 45_000_000_000,
        Retries: 3
    };
    const containers = Object.fromEntries(['fixture-postgres', 'fixture-redis'].map((name) => [name, {
        Id: `fixture-${name}-id`, Image: `sha256:${name.padEnd(64, '0').slice(0, 64)}`,
        State: { Running: true },
        Config: { Image: `${name}:fixture`, Labels: { ...fixtureLabels } },
        NetworkSettings: {
            Networks: {
                [fixtureNetworkName]: {
                    Aliases: [name === 'fixture-postgres' ? 'postgres' : 'redis'],
                    IPAddress: name === 'fixture-postgres' ? '172.30.0.2' : '172.30.0.3',
                    NetworkID: fixtureNetworkId
                }
            }
        }
    }]));
    let topology;
    const trackedFiles = {
        '.gitignore': '.tmp/\n',
        'config/testing/release-reliability-scenario-catalog.json': `${JSON.stringify(catalog, null, 2)}\n`,
        'config/testing/release-reliability-lifecycle-action-registry.json':
            `${JSON.stringify(fixtureLifecycleRegistry(catalog), null, 2)}\n`,
        'config/testing/runtime-state-domain-registry.json':
            `${JSON.stringify({
                schema: 'fsusblog.runtime-state-domain-registry.v1',
                domains: ['fixture-state']
            }, null, 2)}\n`,
        'config/schemas/release-reliability-lifecycle-action-registry.schema.json':
            fs.readFileSync(
                path.join(
                    repositoryRoot,
                    'config/schemas/release-reliability-lifecycle-action-registry.schema.json'
                ),
                'utf8'
            ),
        'tests/performance/perf-policy.yml': fs.readFileSync(
            path.join(repositoryRoot, 'tests/performance/perf-policy.yml'),
            'utf8'
        ),
        'config/testing/mutation/release-parity-subset.json': fs.readFileSync(
            path.join(repositoryRoot, 'config/testing/mutation/release-parity-subset.json'),
            'utf8'
        ),
        'config/deployment/zero-downtime-resource-policy.json': fs.readFileSync(
            path.join(repositoryRoot, 'config/deployment/zero-downtime-resource-policy.json'),
            'utf8'
        ),
        [physicalPolicyRelativePath]:
            repositoryPhysicalPolicyBytes,
        'config/testing/runtime-http-route-contracts.json': fs.readFileSync(
            path.join(repositoryRoot, 'config/testing/runtime-http-route-contracts.json'),
            'utf8'
        ),
        'fixtures/config.env': runtimeEnvironmentText({ namespace: fixtureNamespace }),
        'fixtures/schema.sql': 'CREATE TABLE fixture(id integer);\n',
        'fixtures/seed.json': '{"seed":[1]}\n',
        'fixtures/resources.json': '{"cpu":"exclusive"}\n',
        'fixtures/runtime/.keep': 'fixture\n',
        'src/backend/Infrastructure/Audit/AuditRetentionCatalog.cs': 'public static class AuditRetentionCatalog {}\n',
        'tools/test/verify-release-reliability-receipt.mjs': fs.readFileSync(verifier, 'utf8')
    };
    for (const [relative, contents] of Object.entries(trackedFiles))
    {
        const file = path.join(root, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, contents);
    }
    const fakeTools = path.join(root, '.tmp/tools');
    fs.mkdirSync(fakeTools, { recursive: true });
    const dockerState = path.join(root, '.tmp/docker-state.json');
    fs.writeFileSync(path.join(fakeTools, 'docker'), String.raw`#!/usr/bin/env node
const fs = require('node:fs'); const state = JSON.parse(fs.readFileSync(process.env.FSUSBLOG_RECEIPT_DOCKER_STATE, 'utf8'));
if (process.argv[2] === 'image' && process.argv[3] === 'inspect') { process.stdout.write(JSON.stringify([state.image])); process.exit(0); }
if (process.argv[2] === 'network' && process.argv[3] === 'inspect') { process.stdout.write(JSON.stringify([state.network])); process.exit(0); }
if (process.argv[2] === 'exec') { const command = process.argv.at(-1); const value = state.process; if (command.includes('/proc/1/stat')) { const tail = ['S', '0', String(value.processGroupId), String(value.sessionId), ...Array(15).fill('0'), String(value.startTimeTicks)]; process.stdout.write('1 (FsusBlog.Server) ' + tail.join(' ') + '\n'); } else if (command.includes('/proc/1/environ')) process.stdout.write(Object.entries(value.environment).map(([key, item]) => key + '=' + item).join('\n') + '\n'); else if (command.includes('/proc/1/exe')) process.stdout.write(value.executable + '\n'); else if (command.includes('/proc/1/cmdline')) process.stdout.write(value.commandLine.join('\n') + '\n'); else if (command.includes('/proc/1/cwd')) process.stdout.write(value.workingDirectory + '\n'); else process.exit(1); process.exit(0); }
const requested = process.argv.at(-1); const entry = state.containers[requested] ?? Object.values(state.containers).find((value) => value.Id === requested); if (process.argv[2] !== 'inspect' || !entry) process.exit(1); process.stdout.write(JSON.stringify([entry]));
`);
    fs.chmodSync(path.join(fakeTools, 'docker'), 0o755);
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'verifier@example.invalid'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Verifier Test'], { cwd: root });
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    fs.writeFileSync(dockerState, JSON.stringify({
        containers,
        image: {
            Id: digest('9'),
            RepoDigests: [`fixture/runtime@${digest('9')}`],
            Config: {
                Env: [],
                Healthcheck: structuredClone(fixtureHealthcheck),
                Labels: { 'org.opencontainers.image.revision': commit, ...imageProducerLabels }
            },
            RootFS: { Layers: [digest('a')] }
        },
        network: {
            Id: fixtureNetworkId,
            Name: fixtureNetworkName,
            Driver: 'bridge',
            Labels: { ...fixtureLabels },
            Containers: {}
        },
        process: null
    }));
    const snapshot = await snapshotGitWorktree(root);
    const sourceState = {
        commit,
        worktreeFingerprint: `sha256:${snapshot.fingerprint}`,
        dirtyPathCount: 0,
        hashedPathCount: 0
    };
    const backendEnvironment = containerRuntimeEnvironment({
        namespace: fixtureNamespace,
        sourceCommit: commit,
        sourceFingerprint: sourceState.worktreeFingerprint
    });
    const backendProcess = {
        pid: 1, processGroupId: 1, sessionId: 1, startTimeTicks: '123',
        executable: '/app/FsusBlog.Server', commandLine: ['/app/FsusBlog.Server'],
        workingDirectory: '/app',
        environment: Object.fromEntries(backendEnvironment.map((entry) => entry.split(/=(.*)/su).slice(0, 2)))
    };
    containers['fixture-backend'] = {
        Id: 'fixture-backend-id',
        Image: digest('9'),
        Path: '/app/FsusBlog.Server',
        Args: [],
        State: {
            Running: true,
            Pid: 4242,
            StartedAt: '2026-07-26T00:00:00Z',
            Health: { Status: 'healthy' }
        },
        Config: {
            Image: 'fixture/runtime:immutable',
            Env: backendEnvironment,
            ExposedPorts: { '8080/tcp': {} },
            Healthcheck: structuredClone(fixtureHealthcheck),
            Labels: { ...fixtureLabels }
        },
        HostConfig: {
            PortBindings: {
                '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '24501' }]
            }
        },
        NetworkSettings: {
            Networks: {
                [fixtureNetworkName]: {
                    Aliases: ['backend'],
                    IPAddress: '172.30.0.4',
                    NetworkID: fixtureNetworkId
                }
            },
            Ports: {
                '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '24501' }]
            }
        }
    };
    const liveDockerState = JSON.parse(fs.readFileSync(dockerState, 'utf8'));
    liveDockerState.containers = containers;
    liveDockerState.network.Containers = Object.fromEntries(
        Object.entries(containers).map(([name, container]) => [
            container.Id,
            { Name: name }
        ])
    );
    liveDockerState.process = backendProcess;
    fs.writeFileSync(dockerState, JSON.stringify(liveDockerState));
    topology = sealDocument({
        schema: 'fsusblog.release-reliability-runtime-topology.v1',
        status: 'complete',
        runId,
        namespace: fixtureNamespace,
        root: 'fixtures/runtime',
        config: {
            path: 'fixtures/config.env',
            fileDigest: bytesDigest(Buffer.from(runtimeEnvironmentText({ namespace: fixtureNamespace })))
        },
        schemaFile: { path: 'fixtures/schema.sql', fileDigest: bytesDigest(Buffer.from('CREATE TABLE fixture(id integer);\n')) },
        seed: { path: 'fixtures/seed.json', fileDigest: bytesDigest(Buffer.from('{"seed":[1]}\n')) },
        auditRetentionPolicy: {
            path: 'src/backend/Infrastructure/Audit/AuditRetentionCatalog.cs',
            fileDigest: bytesDigest(Buffer.from('public static class AuditRetentionCatalog {}\n'))
        },
        runtime: {
            profile: 'docker-final-image',
            imageDigest: digest('9'),
            sourceState,
            image: { reference: 'fixture/runtime:immutable', id: digest('9'), revision: commit, layers: [digest('a')], layersDigest: digestValue({ layers: [digest('a')] }) },
            backendContainer: {
                id: containers['fixture-backend'].Id,
                image: containers['fixture-backend'].Image,
                configuredImage: containers['fixture-backend'].Config.Image,
                hostPid: containers['fixture-backend'].State.Pid,
                environment: containers['fixture-backend'].Config.Env,
                path: containers['fixture-backend'].Path,
                args: containers['fixture-backend'].Args,
                startedAt: containers['fixture-backend'].State.StartedAt,
                health: {
                    status: 'healthy',
                    configuration: fixtureHealthcheck,
                    configurationDigest: bytesDigest(Buffer.from(JSON.stringify(
                        canonicalize(fixtureHealthcheck)
                    )))
                },
                portBinding: {
                    containerPort: 8080,
                    hostIp: '127.0.0.1',
                    hostPort: 24501,
                    protocol: 'tcp'
                }
            },
            network: {
                id: fixtureNetworkId,
                name: fixtureNetworkName,
                driver: 'bridge',
                labels: fixtureLabels,
                backend: {
                    containerId: containers['fixture-backend'].Id,
                    aliases: ['backend'],
                    ipv4Address: '172.30.0.4',
                    networkId: fixtureNetworkId
                },
                postgres: {
                    containerId: containers['fixture-postgres'].Id,
                    aliases: ['postgres'],
                    ipv4Address: '172.30.0.2',
                    networkId: fixtureNetworkId
                },
                redis: {
                    containerId: containers['fixture-redis'].Id,
                    aliases: ['redis'],
                    ipv4Address: '172.30.0.3',
                    networkId: fixtureNetworkId
                }
            },
            environmentProjection: {
                source: 'strict-runtime-env-plus-audited-container-overrides',
                effective: Object.fromEntries(
                    backendEnvironment.map((entry) => entry.split(/=(.*)/su).slice(0, 2))
                )
            },
            process: backendProcess
        },
        postgres: { instance: containers['fixture-postgres'].Id, version: '18', configDigest: digestValue({ id: containers['fixture-postgres'].Id, image: containers['fixture-postgres'].Config.Image, imageId: containers['fixture-postgres'].Image, labels: containers['fixture-postgres'].Config.Labels }) },
        redis: { instance: containers['fixture-redis'].Id, version: '8', configDigest: digestValue({ id: containers['fixture-redis'].Id, image: containers['fixture-redis'].Config.Image, imageId: containers['fixture-redis'].Image, labels: containers['fixture-redis'].Config.Labels }) }
    });
    writeJson(path.join(root, '.tmp/topology.json'), topology);
    const buildPath = '.tmp/ci-production-build/receipt.json';
    const artifactRoot = path.join(root, '.tmp/ci-production-build');
    fs.mkdirSync(path.join(artifactRoot, 'payload/backend'), { recursive: true });
    fs.writeFileSync(path.join(artifactRoot, 'payload/backend/FsusBlog.Server.dll'), 'fixture');
    const build = createProductionBuildReceipt({
        root,
        artifactRoot,
        sourceState,
        producer: { runId, runAttempt: 1, job: 'production-build-artifacts' },
        toolchain: collectProductionToolchain({ root }),
        inputPaths: ['config/testing/release-reliability-scenario-catalog.json'],
        domains: [{ name: 'backend-runtime', path: 'payload/backend' }]
    });
    // Bind the CLI attempt to its independent Git/build producer inputs,
    // before constructing the run identity or the receipt under verification.
    const cliAttemptFixture = await createCleanAttemptEvidenceFixture({
        consumerId: 'release-reliability',
        membership: {
            lifecyclePhases: ['measurement', 'postcondition', 'precondition', 'reset'],
            scenarioIds: [...catalog.canonicalScenarioIds].sort()
        },
        schedulerRunId: runId,
        sourceCommit: sourceState.commit,
        worktreeFingerprint: sourceState.worktreeFingerprint,
        buildIdentity: build.contentDigest
    });
    context.after(() => cliAttemptFixture.cleanup());
    const binding = (relative) => ({
        status: 'complete',
        path: relative,
        fileDigest: bytesDigest(fs.readFileSync(path.join(root, relative)))
    });
    const identity = sealDocument({
        schema: 'fsusblog.release-reliability-run-identity.v1',
        status: 'complete',
        invocationId,
        runId,
        sourceState,
        build: {
            ...binding(buildPath),
            contentDigest: build.contentDigest,
            imageDigest: digest('9'),
            image: {
                kind: 'local-docker-image-id',
                reference: 'fixture/runtime:immutable',
                repositoryDigest: null,
                imageDigest: digest('9'),
                revision: commit,
                fsusuiSource: imageProducerLabels['io.fsusblog.build.fsusui-source'],
                fsusuiCommit: imageProducerLabels['io.fsusblog.build.fsusui-commit'],
                layers: [digest('a')],
                layersDigest: digestValue({ layers: [digest('a')] })
            },
            sourceState,
            producerRunId: runId,
            toolchain: build.toolchain
        },
        fixture: {
            status: 'complete',
            root: 'fixtures/runtime',
            namespace: fixtureNamespace,
            config: binding('fixtures/config.env'),
            schema: binding('fixtures/schema.sql'),
            seed: binding('fixtures/seed.json'),
            auditRetentionPolicy: binding('src/backend/Infrastructure/Audit/AuditRetentionCatalog.cs'),
            topology: {
                ...binding('.tmp/topology.json'),
                content: {
                    schema: topology.schema,
                    contentDigest: digestValue(topology),
                    postgres: topology.postgres,
                    redis: topology.redis,
                    auditRetentionPolicy: topology.auditRetentionPolicy,
                    runtime: topology.runtime
                }
            }
        },
        machine: {
            status: 'complete',
            os: `${os.platform()} ${os.release()}`,
            architecture: os.arch(),
            cpuModels: [...new Set(os.cpus().map((cpu) => cpu.model))].sort(),
            cpuCount: os.cpus().length,
            memoryBytes: os.totalmem(),
            cgroup: currentCgroup(),
            schedulerPolicy: binding('fixtures/resources.json')
        },
        tools: [{ id: 'node', status: 'complete', executable: process.execPath, version: process.version }],
        policy: {
            catalog: binding('config/testing/release-reliability-scenario-catalog.json'),
            lifecycleActionRegistry: binding(
                'config/testing/release-reliability-lifecycle-action-registry.json'
            ),
            stateDomainRegistry: binding(
                'config/testing/runtime-state-domain-registry.json'
            ),
            threshold: binding('tests/performance/perf-policy.yml'),
            mutationSubset: binding('config/testing/mutation/release-parity-subset.json'),
            releaseResource: binding('config/deployment/zero-downtime-resource-policy.json'),
            physicalExecution: binding(physicalPolicyRelativePath),
            childEnvironment: childEnvironmentIdentity(catalog),
            executorSchema: 'fsusblog.release-reliability-scenario-result.v3',
            lifecycleSchema: catalog.lifecycleSchema
        },
        collectedAt: '2026-07-26T00:00:00.000Z',
        collectionErrors: []
    });
    const identityPath = `.tmp/release-reliability/${invocationId}/identity.json`;
    writeJson(path.join(root, identityPath), identity);
    const identityRef = { path: identityPath, contentDigest: identity.contentDigest };
    const results = [];
    const files = {
        source: path.join(root, '.gitignore'),
        build: path.join(root, buildPath),
        identity: path.join(root, identityPath),
        fixtureConfig: path.join(root, 'fixtures/config.env'),
        fixtureSchema: path.join(root, 'fixtures/schema.sql'),
        fixtureSeed: path.join(root, 'fixtures/seed.json'),
        fixtureAuditRetentionPolicy: path.join(
            root,
            'src/backend/Infrastructure/Audit/AuditRetentionCatalog.cs'
        ),
        topology: path.join(root, '.tmp/topology.json'),
        catalog: path.join(root, 'config/testing/release-reliability-scenario-catalog.json'),
        lifecycleActionRegistry: path.join(
            root,
            'config/testing/release-reliability-lifecycle-action-registry.json'
        ),
        stateDomainRegistry: path.join(
            root,
            'config/testing/runtime-state-domain-registry.json'
        ),
        threshold: path.join(root, 'tests/performance/perf-policy.yml'),
        mutationSubset: path.join(root, 'config/testing/mutation/release-parity-subset.json'),
        releaseResource: path.join(root, 'config/deployment/zero-downtime-resource-policy.json'),
        physicalExecution: path.join(root, physicalPolicyRelativePath),
        routeCatalog: path.join(root, 'config/testing/runtime-http-route-contracts.json'),
        schedulerPolicy: path.join(root, 'fixtures/resources.json')
    };
    for (const scenario of catalog.scenarios)
    {
        const evidencePath = scenario.authoritativeEvidence.path;
        const evidence = passingVerifierEvidence(root, scenario, {
            invocationId,
            runId,
            scenarioId: scenario.id,
            identityContentDigest: identity.contentDigest,
            sourceState,
            buildContentDigest: build.contentDigest
        });
        writeJson(path.join(root, evidencePath), evidence);
        const evidenceDigest = bytesDigest(fs.readFileSync(path.join(root, evidencePath)));
        const contracts = fixtureLifecycleContracts(catalog);
        const registry = fixtureLifecycleRegistry(catalog);
        contracts.actions = new Map(registry.actions.map((action) => [
            action.actionId,
            action
        ]));
        const lifecycleActionIds = [
            scenario.isolation.lifecycle.preconditions[0],
            scenario.isolation.lifecycle.resetsBefore[0],
            scenario.isolation.lifecycle.measurement,
            scenario.isolation.lifecycle.postconditions[0],
            scenario.isolation.lifecycle.resetsAfter[0]
        ];
        const runtimeObservation = {
            expectedBaseUrl: 'http://127.0.0.1:24501',
            configuredBaseUrl: 'http://127.0.0.1:24501',
            backend: {
                status: 'running',
                id: containers['fixture-backend'].Id,
                hostPid: containers['fixture-backend'].State.Pid,
                startedAt: containers['fixture-backend'].State.StartedAt,
                image: containers['fixture-backend'].Image
            },
            postgres: {
                status: 'running',
                id: containers['fixture-postgres'].Id,
                hostPid: containers['fixture-postgres'].State.Pid,
                startedAt: containers['fixture-postgres'].State.StartedAt,
                image: containers['fixture-postgres'].Image
            },
            redis: {
                status: 'running',
                id: containers['fixture-redis'].Id,
                hostPid: containers['fixture-redis'].State.Pid,
                startedAt: containers['fixture-redis'].State.StartedAt,
                image: containers['fixture-redis'].Image
            },
            network: {
                status: 'bound',
                id: fixtureNetworkId,
                memberContainerIds: [
                    containers['fixture-backend'].Id,
                    containers['fixture-postgres'].Id,
                    containers['fixture-redis'].Id
                ].sort()
            },
            live: { status: 'live', httpStatus: 200, reportStatus: 'live' }
        };
        const lifecycleActions = [];
        let baseline = null;
        for (let index = 0; index < lifecycleActionIds.length; index += 1)
        {
            const action = contracts.actions.get(lifecycleActionIds[index]);
            let reference;
            if (action.phase === 'measurement')
            {
                reference = verifyLifecycleActionReceipt({
                    repositoryRoot: root,
                    action,
                    scenario,
                    invocationId,
                    runId,
                    identity,
                    identityReference: identityRef
                });
            }
            else
            {
                const relative = action.expectedReceiptPath
                    .replaceAll('{actionId}', action.actionId)
                    .replaceAll('{invocationId}', invocationId)
                    .replaceAll('{runId}', runId)
                    .replaceAll('{scenarioId}', scenario.id);
                const operation = {
                    kind: action.operation,
                    ...(baseline === null
                        ? {}
                        : {
                            runtimeBaselineReceipt: {
                                path: baseline.path,
                                bytesDigest: baseline.bytesDigest,
                                contentDigest: baseline.contentDigest
                            }
                        })
                };
                const actionReceipt = sealDocument({
                    schema: catalog.lifecycleSchema,
                    status: 'passed',
                    actionId: action.actionId,
                    phase: action.phase,
                    scenarioId: scenario.id,
                    invocationId,
                    runId,
                    identity: identityRef,
                    stateDomains: action.stateDomains,
                    operation,
                    observations: {
                        before: runtimeObservation,
                        after: runtimeObservation
                    },
                    finalObservation: {
                        status: 'passed',
                        postStateDigest: digestValue({
                            state: runtimeObservation
                        }),
                        failures: []
                    },
                    startedAt: `2026-07-26T00:00:0${index * 2}.000Z`,
                    finishedAt:
                        `2026-07-26T00:00:0${index * 2 + 1}.000Z`
                });
                writeJson(path.join(root, relative), actionReceipt);
                reference = verifyLifecycleActionReceipt({
                    repositoryRoot: root,
                    action,
                    scenario,
                    invocationId,
                    runId,
                    identity,
                    identityReference: identityRef
                });
                baseline ??= reference;
                if (scenario.id === scenarioIds[0]
                    && action.phase === 'reset-before')
                {
                    files.lifecycle = path.join(root, relative);
                }
            }
            const processTree = writeFixtureProcessTreeReceipt({
                repositoryRoot: root,
                identity,
                identityReference: identityRef,
                scenario,
                action,
                index
            });
            if (scenario.id === scenarioIds[0]
                && action.phase === 'measurement')
            {
                files.processTree = path.join(
                    root,
                    processTree.reference.path
                );
            }
            lifecycleActions.push({
                actionId: action.actionId,
                phase: action.phase,
                status: 'passed',
                startedAt: `2026-07-26T00:00:0${index * 2}.000Z`,
                finishedAt: `2026-07-26T00:00:0${index * 2 + 1}.000Z`,
                durationMs: 1000,
                exitCode: 0,
                signal: null,
                timedOut: false,
                stdoutLog: `.tmp/logs/${action.actionId}.stdout.log`,
                stderrLog: `.tmp/logs/${action.actionId}.stderr.log`,
                receipt: reference,
                processTreeReceipt: processTree.reference,
                terminalFence: processTree.terminalFence,
                finalObservation: reference.finalObservation,
                failure: null
            });
        }
        const lifecycle = {
            actions: lifecycleActions,
            verifiedActionReceipts: lifecycleActions.map(
                (action) => action.receipt
            ),
            resetPostObservation: lifecycleActions[1].finalObservation,
            finalPostObservation: lifecycleActions[4].finalObservation
        };
        const resultPath = `.tmp/release-reliability/${invocationId}/scenario-results/${scenario.id}.json`;
        const result = sealDocument({
            schema: 'fsusblog.release-reliability-scenario-result.v3',
            invocationId,
            runId,
            scenarioId: scenario.id,
            resultPath,
            owner: scenario.owner,
            resourceClass: scenario.resourceClass,
            evidenceClass: 'correctness',
            qualificationEligible: true,
            status: 'passed',
            identity: identityRef,
            startedAt: '2026-07-26T00:00:00.000Z',
            finishedAt: '2026-07-26T00:00:10.000Z',
            producer: producerRecord(
                scenario,
                identity,
                lifecycleActions.find((action) => action.phase === 'measurement')
                    .processTreeReceipt
            ),
            lifecycle,
            authoritativeEvidence: {
                path: evidencePath,
                digest: evidenceDigest,
                schema: lifecycleActions[2].receipt.schema,
                status: 'ok'
            },
            outputs: [{ id: 'authoritative-evidence', path: evidencePath, digest: evidenceDigest }],
            firstFailure: null,
            cleanupFailures: [],
            terminalFence: lifecycleActions.find(
                (action) => action.phase === 'measurement'
            ).terminalFence,
            cancellation: null,
            failure: null,
            recordedAt: '2026-07-26T00:00:11.000Z'
        });
        writeJson(path.join(root, resultPath), result);
        results.push(result);
        if (scenario.id === scenarioIds[0])
        {
            files.evidence = path.join(root, evidencePath);
            files.result = path.join(root, resultPath);
        }
    }
    const timeline = createTimeline({
        invocationId,
        runId,
        scenarioResults: results,
        identityReference: identityRef,
        createdAt: '2026-07-26T00:00:12.000Z'
    });
    const timelinePath = `.tmp/release-reliability/${invocationId}/timeline.json`;
    writeJson(path.join(root, timelinePath), timeline);
    files.timeline = path.join(root, timelinePath);
    const receipt = createCandidateReceipt({
        repositoryRoot: root,
        attemptEvidence: cliAttemptFixture.attemptEvidence,
        expectedCandidate: cliAttemptFixture.expectedCandidate,
        invocationId,
        runId,
        scenarioResults: results,
        identity,
        identityReference: identityRef,
        timeline,
        timelineReference: { path: timelinePath, contentDigest: timeline.contentDigest },
        catalog,
        lifecycleContracts: {
            ...fixtureLifecycleContracts(catalog),
            authorityBindings: {
                lifecycleActionRegistry: identity.policy.lifecycleActionRegistry,
                stateDomainRegistry: identity.policy.stateDomainRegistry
            }
        },
        createdAt: '2026-07-26T00:00:12.000Z'
    });
    assert.equal(receipt.status, 'candidate', receipt.failure);
    const receiptPath = `.tmp/release-reliability/${invocationId}/candidate-receipt.json`;
    writeJson(path.join(root, receiptPath), receipt);
    files.receipt = path.join(root, receiptPath);
    return {
        root,
        catalog,
        identity,
        results,
        timeline,
        receipt,
        receiptPath,
        receiptFile: path.join(root, receiptPath),
        timelineFile: path.join(root, timelinePath),
        files
        , fakeTools,
        dockerState,
        containers
    };
}

function verifyCli(fixture)
{
    return spawnSync(process.execPath, [
        verifier,
        '--root',
        fixture.root,
        '--candidate',
        fixture.receiptPath,
        '--attestation-out',
        `.tmp/release-reliability/${invocationId}/verified-attestation.json`
    ], { encoding: 'utf8', env: { ...process.env, PATH: `${fixture.fakeTools}${path.delimiter}${process.env.PATH ?? ''}`, FSUSBLOG_RECEIPT_DOCKER_STATE: fixture.dockerState } });
}

function verifyCliPreflight(fixture)
{
    const result = verifyCli(fixture);
    assert.equal(result.status, 0, result.stderr);
    const attestation = JSON.parse(fs.readFileSync(path.join(
        fixture.root,
        `.tmp/release-reliability/${invocationId}/verified-attestation.json`
    ), 'utf8'));
    assert.equal(attestation.status, 'verified');
    assert.equal(attestation.runId, runId);
    assert.equal(attestation.candidate.path, fixture.receiptPath);
    assert.equal(attestation.candidate.fileDigest, bytesDigest(fs.readFileSync(fixture.receiptFile)));
}

function assertVerifierRejection(result, message)
{
    assert.equal(result.stderr.trim(), `[release-reliability-receipt] ${message}`);
}

function finalizeCli(fixture)
{
    const invocationRoot = `.tmp/release-reliability/${invocationId}`;
    return spawnSync(process.execPath, [
        verifier,
        '--root',
        fixture.root,
        '--candidate',
        fixture.receiptPath,
        '--attestation',
        `${invocationRoot}/verified-attestation.json`,
        '--finalize-out',
        `${invocationRoot}/qualified-receipt.json`
    ], { encoding: 'utf8' });
}

function verifyTerminalCli(fixture)
{
    return spawnSync(process.execPath, [
        verifier,
        '--root',
        fixture.root,
        '--receipt',
        `.tmp/release-reliability/${invocationId}/qualified-receipt.json`
    ], { encoding: 'utf8' });
}

function rewriteEvidenceAndAggregate(fixture, scenarioId, mutate)
{
    const candidate = JSON.parse(fs.readFileSync(fixture.receiptFile, 'utf8'));
    const scenarioReference = candidate.scenarios.find(
        (reference) => reference.scenarioId === scenarioId
    );
    const evidenceFile = path.join(fixture.root, scenarioReference.evidencePath);
    const evidence = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));
    mutate(evidence);
    writeJson(evidenceFile, evidence);
    const evidenceDigest = bytesDigest(fs.readFileSync(evidenceFile));

    const resultFile = path.join(fixture.root, scenarioReference.resultPath);
    const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    result.authoritativeEvidence.digest = evidenceDigest;
    result.outputs[0].digest = evidenceDigest;
    const resealedResult = sealDocument(result);
    writeJson(resultFile, resealedResult);

    const timeline = JSON.parse(fs.readFileSync(fixture.timelineFile, 'utf8'));
    const timelineReference = timeline.scenarioResults.find(
        (reference) => reference.scenarioId === scenarioId
    );
    timelineReference.resultContentDigest = resealedResult.contentDigest;
    timelineReference.evidenceDigest = evidenceDigest;
    const resealedTimeline = sealDocument(timeline);
    writeJson(fixture.timelineFile, resealedTimeline);

    scenarioReference.resultContentDigest = resealedResult.contentDigest;
    scenarioReference.evidenceDigest = evidenceDigest;
    candidate.timeline.contentDigest = resealedTimeline.contentDigest;
    writeJson(fixture.receiptFile, sealDocument(candidate));
}

test('independent verifier re-reads every bound file and accepts an untampered receipt', async (context) =>
{
    const fixture = await createCliFixture(context);
    const result = verifyCli(fixture);
    assert.equal(result.status, 0, result.stderr);
    const source = fs.readFileSync(verifier, 'utf8');
    assert.doesNotMatch(source, /from '.\/release-reliability-receipt\.mjs'/u);
    assert.doesNotMatch(source, /mtime/u);
});

test('independent verifier requires the dedicated data-scale closed environment sets', async (context) =>
{
    const fixture = await createCliFixture(context);
    const scenario = fixture.catalog.scenarios.find((entry) => entry.id === 'release-data-scale-m');
    assert.deepEqual(scenario.command.env, {
        FSUSBLOG_DATA_SCALE_CONCURRENCY: '2',
        FSUSBLOG_DATA_SCALE_PROVISION_MODE: 'full',
        FSUSBLOG_DATA_SCALE_REQUESTS: '12',
        FSUSBLOG_DATA_SCALE_ROOT: '.tmp/scale',
        FSUSBLOG_SCALE_TIER: 'scale-m'
    });
    assert.deepEqual(scenario.command.inheritEnv, {
        required: ['FSUSBLOG_TEST_NAMESPACE', 'FSUSBLOG_TEST_RUN_ID'],
        optional: [
            'FSUSBLOG_AOT_CACHE_DIR',
            'FSUSBLOG_BACKEND_WEBROOT',
            'FSUSBLOG_DEBUG_BACKEND_URL',
            'FSUSBLOG_POSTGRES_CONTAINER_NAME',
            'FSUSBLOG_PUBLIC_AOT_CACHE_DIR',
            'FSUSBLOG_REDIS_CONTAINER_NAME',
            'FSUSBLOG_SEARCH_DIR',
            'FSUSBLOG_SEARCH_INDEX_DIR',
            'FSUSBLOG_WEB_ROOT'
        ]
    });
    verifyCliPreflight(fixture);
    const catalogFile = fixture.files.catalog;
    const original = fs.readFileSync(catalogFile);
    const mutations = [
        (command) =>
        {
            delete command.env.FSUSBLOG_DATA_SCALE_PROVISION_MODE;
        },
        (command) =>
        {
            command.env.FSUSBLOG_DATA_SCALE_PROVISION_MODE = 'plan-identity';
        },
        (command) =>
        {
            command.env.FSUSBLOG_DATA_SCALE_PROVISION_MODE = 'seed-only';
        },
        (command) =>
        {
            command.env.FSUSBLOG_UNDECLARED_FIXED_VALUE = '1';
        },
        (command) =>
        {
            command.inheritEnv.required = ['FSUSBLOG_TEST_RUN_ID'];
        },
        (command) =>
        {
            command.inheritEnv.required = ['FSUSBLOG_TEST_NAMESPACE'];
        },
        (command) =>
        {
            command.inheritEnv.required = [
                'FSUSBLOG_DEBUG_BACKEND_URL', 'FSUSBLOG_POSTGRES_CONTAINER_NAME',
                'FSUSBLOG_REDIS_CONTAINER_NAME', 'FSUSBLOG_TEST_NAMESPACE', 'FSUSBLOG_TEST_RUN_ID'
            ];
            command.inheritEnv.optional = command.inheritEnv.optional.filter((key) =>
                !command.inheritEnv.required.includes(key));
        },
        (command) =>
        {
            command.inheritEnv.optional.push('FSUSBLOG_UNDECLARED_OPTIONAL');
            command.inheritEnv.optional.sort();
        },
        (command) =>
        {
            command.inheritEnv.required.push('FSUSBLOG_UNDECLARED_REQUIRED');
            command.inheritEnv.required.sort();
        },
        (command) =>
        {
            command.inheritEnv.required = ['FSUSBLOG_TEST_NAMESPACE'];
            command.inheritEnv.optional.push('FSUSBLOG_TEST_RUN_ID');
            command.inheritEnv.optional.sort();
        },
        (command) =>
        {
            command.inheritEnv.optional = command.inheritEnv.optional.filter((key) =>
                key !== 'FSUSBLOG_REDIS_CONTAINER_NAME');
        }
    ];
    for (const mutate of mutations)
    {
        const mutated = JSON.parse(original);
        mutate(mutated.scenarios.find((entry) => entry.id === 'release-data-scale-m').command);
        writeJson(catalogFile, mutated);
        const result = verifyCli(fixture);
        assert.notEqual(result.status, 0);
        assertVerifierRejection(result, 'canonical scenario catalog is invalid');
        fs.writeFileSync(catalogFile, original);
    }
    verifyCliPreflight(fixture);
});

test('independent verifier rejects a forged threshold check after the exact policy passes', async (context) =>
{
    const fixture = await createCliFixture(context);
    verifyCliPreflight(fixture);
    rewriteEvidenceAndAggregate(fixture, 'release-load-peak', (evidence) =>
    {
        evidence.thresholdEvaluation.checks[0].threshold = 999999;
    });
    const result = verifyCli(fixture);
    assert.notEqual(result.status, 0);
    assertVerifierRejection(result, 'scenario release-load-peak forged threshold check: p95Ms');
});

test('independent verifier rejects self-recomputed weakened effective, sampling, threshold, and policy evidence', async (context) =>
{
    const mutations = [
        (evidence) =>
        {
            evidence.effective.concurrency = 1;
        },
        (evidence) =>
        {
            evidence.sampling.totalRequests = 1;
        },
        (evidence) =>
        {
            evidence.thresholds.maxP95Ms = 999999;
            evidence.thresholdEvaluation.checks[0].threshold = 999999;
        },
        (evidence) =>
        {
            evidence.policy.fileDigest = digest('f');
        }
    ];
    for (const mutate of mutations)
    {
        const fixture = await createCliFixture(context);
        verifyCliPreflight(fixture);
        rewriteEvidenceAndAggregate(fixture, 'release-load-peak', mutate);
        const result = verifyCli(fixture);
        assert.notEqual(result.status, 0);
        assertVerifierRejection(result, 'scenario release-load-peak effective load policy/sampling mismatch');
    }
});

test('independent verifier rejects self-recomputed scale and mutation authority substitution', async (context) =>
{
    const scaleFixture = await createCliFixture(context);
    verifyCliPreflight(scaleFixture);
    rewriteEvidenceAndAggregate(scaleFixture, 'release-data-scale-m', (evidence) =>
    {
        evidence.tier = 'scale-xs';
        evidence.sampling = { requests: 1, concurrency: 1, routeCount: 3 };
    });
    const scaleResult = verifyCli(scaleFixture);
    assert.notEqual(scaleResult.status, 0);
    assertVerifierRejection(scaleResult, 'scenario release-data-scale-m effective scale tier/sampling mismatch');

    const mutationFixture = await createCliFixture(context);
    verifyCliPreflight(mutationFixture);
    rewriteEvidenceAndAggregate(
        mutationFixture,
        'release-mutation-critical-slice',
        (evidence) =>
        {
            evidence.releaseQualification.policy.subsetDigest = digest('e');
            evidence.releaseQualification.executedMutantIds = ['substituted-mutant'];
        }
    );
    const mutationResult = verifyCli(mutationFixture);
    assert.notEqual(mutationResult.status, 0);
    assertVerifierRejection(mutationResult, 'scenario release-mutation-critical-slice release mutation qualification mismatch');
});

test('verified attestation finalizes and re-verifies after every live container is removed', async (context) =>
{
    const fixture = await createCliFixture(context);
    const live = verifyCli(fixture);
    assert.equal(live.status, 0, live.stderr);
    const state = JSON.parse(fs.readFileSync(fixture.dockerState, 'utf8'));
    state.containers = {};
    fs.writeFileSync(fixture.dockerState, JSON.stringify(state));
    const finalized = finalizeCli(fixture);
    assert.equal(finalized.status, 0, finalized.stderr);
    const receipt = JSON.parse(fs.readFileSync(path.join(
        fixture.root,
        `.tmp/release-reliability/${invocationId}/qualified-receipt.json`
    ), 'utf8'));
    assert.deepEqual(receipt.buildIdentity, {
        imageDigest: digest('9'),
        revision: fixture.identity.sourceState.commit,
        fsusuiSource: imageProducerLabels['io.fsusblog.build.fsusui-source'],
        fsusuiCommit: imageProducerLabels['io.fsusblog.build.fsusui-commit']
    });
    const terminal = verifyTerminalCli(fixture);
    assert.equal(terminal.status, 0, terminal.stderr);
});

test('candidate without attestation and tampered or cross-run attestation cannot finalize', async (context) =>
{
    const fixture = await createCliFixture(context);
    assert.notEqual(finalizeCli(fixture).status, 0);
    assert.equal(verifyCli(fixture).status, 0);
    const attestationFile = path.join(
        fixture.root,
        `.tmp/release-reliability/${invocationId}/verified-attestation.json`
    );
    const original = fs.readFileSync(attestationFile);
    const attestation = JSON.parse(original);
    attestation.runId = 'different-run';
    writeJson(attestationFile, sealDocument(attestation));
    assert.notEqual(finalizeCli(fixture).status, 0);
    fs.writeFileSync(attestationFile, original);
    fs.appendFileSync(fixture.files.evidence, '\ntampered\n');
    assert.notEqual(finalizeCli(fixture).status, 0);
});

test('tamper after receipt fails for every source, identity, evidence, lifecycle, and aggregate binding', async (context) =>
{
    const fixture = await createCliFixture(context);
    verifyCliPreflight(fixture);
    const sourceMismatch = 'run source identity does not match the current worktree bytes/mode/index state';
    const expectedMessages = {
        source: sourceMismatch,
        build: 'build receipt bytes digest mismatch',
        identity: 'run identity is not valid JSON',
        fixtureConfig: sourceMismatch,
        fixtureSchema: sourceMismatch,
        fixtureSeed: sourceMismatch,
        fixtureAuditRetentionPolicy: sourceMismatch,
        topology: 'fixture topology bytes digest mismatch',
        catalog: 'canonical scenario catalog is not valid JSON',
        threshold: sourceMismatch,
        mutationSubset: sourceMismatch,
        releaseResource: sourceMismatch,
        physicalExecution: sourceMismatch,
        routeCatalog: sourceMismatch,
        schedulerPolicy: sourceMismatch,
        lifecycle: 'action receipt bytes digest mismatch',
        processTree: 'release-soak-min-fixture-measurement process-tree receipt is not valid JSON',
        evidence: 'scenario release-soak-min evidence bytes/reference mismatch',
        result: 'scenario release-soak-min result is not valid JSON',
        timeline: 'timeline is not valid JSON',
        receipt: 'candidate receipt is not valid JSON'
    };
    for (const [label, file] of Object.entries(fixture.files))
    {
        const original = fs.readFileSync(file);
        fs.chmodSync(file, fs.statSync(file).mode | 0o200);
        fs.writeFileSync(file, Buffer.concat([original, Buffer.from(`\n${label}-tamper`)]));
        const result = verifyCli(fixture);
        assert.notEqual(result.status, 0, `${label} tamper unexpectedly passed`);
        if (['lifecycleActionRegistry', 'stateDomainRegistry'].includes(label))
        {
            // These two owners parse their JSON before the source snapshot check.
            assert.throws(() => JSON.parse(fs.readFileSync(file, 'utf8')), (error) =>
            {
                assertVerifierRejection(result, error.message);
                return true;
            });
        }
        else
        {
            assert.equal(typeof expectedMessages[label], 'string', `missing exact oracle for ${label}`);
            assertVerifierRejection(result, expectedMessages[label]);
        }
        fs.writeFileSync(file, original);
    }
});

test('independent verifier rejects stopped, replaced, and topology-image-mismatched live fixture state', async (context) =>
{
    const messages = [
        'fixture postgres container identity changed or stopped',
        'fixture redis container identity changed or stopped',
        'fixture postgres inspected topology digest mismatch',
        'fixture backend app container no longer binds image, health, port, ownership, and PID',
        'fixture backend app container no longer binds image, health, port, ownership, and PID',
        'fixture backend app container no longer binds image, health, port, ownership, and PID',
        'fixture postgres runtime network attachment changed',
        'fixture backend app container no longer binds image, health, port, ownership, and PID',
        'fixture runtime network aliases or membership changed'
    ];
    const mutations = [
        (state) =>
        {
            state.containers['fixture-postgres'].State.Running = false;
        },
        (state) =>
        {
            state.containers['fixture-redis'].Id = 'recycled-redis-id';
        },
        (state) =>
        {
            state.containers['fixture-postgres'].Image = `sha256:${'f'.repeat(64)}`;
        },
        (state) =>
        {
            state.containers['fixture-backend'].State.Pid += 1;
        },
        (state) =>
        {
            state.containers['fixture-backend'].State.Health.Status = 'unhealthy';
        },
        (state) =>
        {
            state.containers['fixture-backend'].Config.Env.push(
                `FSUSBLOG_TEST_RUN_ID=${runId}`
            );
        },
        (state) =>
        {
            state.containers['fixture-postgres'].NetworkSettings
                .Networks['verifier-fixture-network'].Aliases = ['wrong-postgres'];
        },
        (state) =>
        {
            state.containers['fixture-backend'].HostConfig
                .PortBindings['8080/tcp'][0].HostIp = '0.0.0.0';
        },
        (state) =>
        {
            delete state.network.Containers['fixture-fixture-redis-id'];
        }
    ];
    assert.equal(mutations.length, messages.length);
    for (const [index, mutate] of mutations.entries())
    {
        const fixture = await createCliFixture(context);
        verifyCliPreflight(fixture);
        const state = JSON.parse(fs.readFileSync(fixture.dockerState, 'utf8'));
        mutate(state);
        fs.writeFileSync(fixture.dockerState, JSON.stringify(state));
        const result = verifyCli(fixture);
        assert.notEqual(result.status, 0);
        assertVerifierRejection(result, messages[index]);
    }
});

test('independent verifier rejects replaced and cross-source registry image inspection', async (context) =>
{
    const messages = [
        'runtime image ID, source revision, or RootFS layers changed',
        'runtime image source or FsusUI producer labels changed',
        'runtime image source or FsusUI producer labels changed',
        'runtime image source or FsusUI producer labels changed',
        'runtime image source or FsusUI producer labels changed'
    ];
    const mutations = [
        (state) =>
        {
            state.image.Id = digest('f');
        },
        (state) =>
        {
            state.image.Config.Labels['org.opencontainers.image.revision'] = '0'.repeat(40);
        },
        (state) =>
        {
            state.image.Config.Labels['io.fsusblog.build.fsusui-source'] = 'published-package';
        },
        (state) =>
        {
            delete state.image.Config.Labels['io.fsusblog.build.fsusui-commit'];
        },
        (state) =>
        {
            state.image.Config.Labels['io.fsusblog.build.fsusui-commit'] = '1'.repeat(40);
        }
    ];
    assert.equal(mutations.length, messages.length);
    for (const [index, mutate] of mutations.entries())
    {
        const fixture = await createCliFixture(context);
        verifyCliPreflight(fixture);
        const state = JSON.parse(fs.readFileSync(fixture.dockerState, 'utf8'));
        mutate(state);
        fs.writeFileSync(fixture.dockerState, JSON.stringify(state));
        const result = verifyCli(fixture);
        assert.notEqual(result.status, 0);
        assertVerifierRejection(result, messages[index]);
    }
});

test('verifier rejects cross-root references and symlinks without consulting mtime', async (context) =>
{
    const fixture = await createCliFixture(context);
    verifyCliPreflight(fixture);
    const originalReceipt = fs.readFileSync(fixture.receiptFile);
    const escaped = structuredClone(fixture.receipt);
    escaped.scenarios[0].evidencePath = '../outside.json';
    writeJson(fixture.receiptFile, sealDocument(escaped));
    const escapedResult = verifyCli(fixture);
    assert.notEqual(escapedResult.status, 0);
    assertVerifierRejection(escapedResult, 'scenario release-data-scale-m evidence path is unsafe');
    fs.writeFileSync(fixture.receiptFile, originalReceipt);

    const noncanonical = structuredClone(fixture.receipt);
    noncanonical.scenarios[0].evidencePath = `.tmp/evidence/../evidence/${scenarioIds[0]}.json`;
    writeJson(fixture.receiptFile, sealDocument(noncanonical));
    const noncanonicalResult = verifyCli(fixture);
    assert.notEqual(noncanonicalResult.status, 0);
    assertVerifierRejection(noncanonicalResult, 'scenario release-data-scale-m evidence path is unsafe');
    fs.writeFileSync(fixture.receiptFile, originalReceipt);

    const originalEvidence = fs.readFileSync(fixture.files.evidence);
    const target = path.join(fixture.root, '.tmp', 'same-evidence.json');
    fs.writeFileSync(target, originalEvidence);
    fs.rmSync(fixture.files.evidence);
    fs.symlinkSync(target, fixture.files.evidence);
    const symlinkResult = verifyCli(fixture);
    assert.notEqual(symlinkResult.status, 0);
    assertVerifierRejection(symlinkResult, 'scenario release-soak-min evidence path contains a symlink');
});

test('an old receipt cannot be verified after the repository advances to a new commit', async (context) =>
{
    const fixture = await createCliFixture(context);
    fs.appendFileSync(path.join(fixture.root, '.gitignore'), '# new source\n');
    execFileSync('git', ['add', '.gitignore'], { cwd: fixture.root });
    execFileSync('git', ['commit', '-qm', 'new source'], { cwd: fixture.root });
    const verification = verifyCli(fixture);
    assert.notEqual(verification.status, 0);
    assert.match(verification.stderr, /run source identity does not match/u);
});

test('self-recomputed placeholder lifecycle cannot become qualified', async (context) =>
{
    const fixture = await createCliFixture(context);
    const lifecycle = JSON.parse(fs.readFileSync(fixture.files.lifecycle, 'utf8'));
    lifecycle.observations = {};
    const resealedLifecycle = sealDocument(lifecycle);
    writeJson(fixture.files.lifecycle, resealedLifecycle);
    const resealedBytesDigest = bytesDigest(
        fs.readFileSync(fixture.files.lifecycle)
    );

    const result = structuredClone(fixture.results[0]);
    for (const reference of [
        result.lifecycle.verifiedActionReceipts[1],
        result.lifecycle.actions[1].receipt
    ])
    {
        reference.contentDigest = resealedLifecycle.contentDigest;
        reference.bytesDigest = resealedBytesDigest;
    }
    const resealedResult = sealDocument(result);
    writeJson(fixture.files.result, resealedResult);

    const timeline = structuredClone(fixture.timeline);
    const timelineReference = timeline.scenarioResults.find(
        (reference) => reference.scenarioId === result.scenarioId
    );
    timelineReference.resultContentDigest = resealedResult.contentDigest;
    timelineReference.lifecycleActions[1].receipt.contentDigest =
        resealedLifecycle.contentDigest;
    timelineReference.lifecycleActions[1].receipt.bytesDigest =
        resealedBytesDigest;
    const resealedTimeline = sealDocument(timeline);
    writeJson(fixture.timelineFile, resealedTimeline);

    const receipt = structuredClone(fixture.receipt);
    const receiptReference = receipt.scenarios.find(
        (reference) => reference.scenarioId === result.scenarioId
    );
    receiptReference.resultContentDigest = resealedResult.contentDigest;
    receiptReference.lifecycleActions[1].receipt.contentDigest =
        resealedLifecycle.contentDigest;
    receiptReference.lifecycleActions[1].receipt.bytesDigest =
        resealedBytesDigest;
    receipt.timeline.contentDigest = resealedTimeline.contentDigest;
    writeJson(fixture.receiptFile, sealDocument(receipt));
    const verification = verifyCli(fixture);
    assert.notEqual(verification.status, 0);
    assert.match(
        verification.stderr,
        /operation\/observation contract mismatch/u
    );
});

test('self-recomputed build receipt cannot break the immutable identity binding', async (context) =>
{
    const fixture = await createCliFixture(context);
    const build = JSON.parse(fs.readFileSync(fixture.files.build, 'utf8'));
    build.toolchain.node = 'attacker-recomputed-version';
    fs.chmodSync(fixture.files.build, fs.statSync(fixture.files.build).mode | 0o200);
    writeJson(fixture.files.build, sealDocument(build));

    const verification = verifyCli(fixture);
    assert.notEqual(verification.status, 0);
    assert.match(verification.stderr, /build receipt bytes digest mismatch/u);
});

test('self-recomputed result cannot substitute a different producer invocation', async (context) =>
{
    const fixture = await createCliFixture(context);
    const result = structuredClone(fixture.results[0]);
    result.producer.executable = '/tmp/substituted-producer';
    const resealedResult = sealDocument(result);
    writeJson(fixture.files.result, resealedResult);

    const timeline = structuredClone(fixture.timeline);
    timeline.scenarioResults.find((reference) => reference.scenarioId === result.scenarioId).resultContentDigest
        = resealedResult.contentDigest;
    const resealedTimeline = sealDocument(timeline);
    writeJson(fixture.timelineFile, resealedTimeline);

    const receipt = structuredClone(fixture.receipt);
    receipt.scenarios.find((reference) => reference.scenarioId === result.scenarioId).resultContentDigest
        = resealedResult.contentDigest;
    receipt.timeline.contentDigest = resealedTimeline.contentDigest;
    writeJson(fixture.receiptFile, sealDocument(receipt));

    const verification = verifyCli(fixture);
    assert.notEqual(verification.status, 0);
    assert.match(verification.stderr, /producer invocation mismatch/u);
});
