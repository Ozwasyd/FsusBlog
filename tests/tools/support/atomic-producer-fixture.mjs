import path from 'node:path';
import { URL } from 'node:url';

const { digestCanonical, sealContentDigest, sha256 } = await import(new URL('../../../tools/test/attempt-provenance.mjs', import.meta.url));
const { canonicalTestId, planExactShards, REPLAY_PLAN_SCHEMA, sealReplayPlan } = await import(new URL('../../../tools/test/execution-replay-contract.mjs', import.meta.url));

const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
const commandFixture = path.join(repositoryRoot, 'tests/tools/support/atomic-producer-command.mjs');

export function atomicReference(material)
{
    return { id: material.id, contentDigest: material.contentDigest };
}

/** Synthetic owner projections for isolated contract tests, never qualification. */
export function atomicFixture({ alphaScenario = 'success', betaScenario = 'success', startedMarker } = {})
{
    const authorities = {
        physicalOwnership: [],
        commandSources: [],
        inputClosures: [],
        fixtureProfiles: [],
        replayPlans: [],
        resourceContracts: [],
        stateAccess: [],
        finalizerOperations: []
    };
    const profile = sealContentDigest({ id: 'isolated-static-fixture', fixtureKind: 'test-only' });
    const resources = sealContentDigest({
        id: 'isolated-static-resources',
        resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 }
    });
    const finalizer = sealContentDigest({ id: 'isolated-cleanup', purpose: 'cleanup' });
    authorities.fixtureProfiles.push(profile);
    authorities.resourceContracts.push(resources);
    authorities.finalizerOperations.push(finalizer);
    const producers = [
        ['alpha-check', alphaScenario, []],
        ['beta-check', betaScenario, []],
        ['dependent-check', 'success', ['alpha-check']]
    ].map(([id, scenario, dependsOn]) =>
    {
        const testId = canonicalTestId({ framework: 'node-test', source: 'tests/tools/atomic-producer-compiler.test.mjs', name: ['isolated-fixture', id] });
        const command = [process.execPath, commandFixture, scenario, testId];
        if (scenario === 'marker-wait')
        {
            command.push(startedMarker);
        }
        const closure = sealContentDigest({
            id: `${id}-inputs`,
            commandSourceId: `${id}-command`,
            commandDigest: digestCanonical(command),
            unresolvedDynamicReads: []
        });
        const source = sealContentDigest({
            id: `${id}-command`,
            command,
            executableAuthorityCount: 1,
            inputClosureRef: atomicReference(closure)
        });
        const plan = sealReplayPlan({
            schema: REPLAY_PLAN_SCHEMA,
            source: { commit: '1'.repeat(40), worktreeFingerprint: `sha256:${'2'.repeat(64)}` },
            producer: { id, framework: 'node-test' },
            run: { id: 'isolated-atomic-run', mode: 'diagnostic' },
            rootSeed: `seed256:${'ab'.repeat(32)}`,
            entropySources: [{ id: 'root-seed', kind: 'root-seed', source: 'cli' }],
            randomStreams: [],
            ...planExactShards({ testIds: [testId], shardCount: 1 }),
            workers: { ids: ['isolated-worker'], assignmentPolicy: 'framework-owned-after-seal' },
            frameworkModes: [{ name: 'retry', value: 'disabled' }],
            schedulerReadyPolicy: { kind: 'sealed-shard-order', dynamicReassignment: false },
            schedulerShuffleSeed: 'fixed-fixture-scheduler-seed',
            command: { executable: command[0], args: command.slice(1), environmentDigest: digestCanonical({ PATH: process.env.PATH }) }
        });
        const replay = {
            id: `${id}-replay`,
            replayOwner: 'isolated-replay-owner',
            fixtureProfileDigest: profile.contentDigest,
            artifactPath: `${id}.replay-plan.json`,
            bytes: `${JSON.stringify(plan, null, 4)}\n`,
            plan
        };
        const node = {
            kind: 'atomic-producer',
            producerId: id,
            logicalParentId: 'fixture-summary',
            owner: 'isolated-producer-owner',
            commandSourceRef: atomicReference(source),
            executionClass: 'static',
            evidenceClass: 'correctness',
            attemptPolicyId: 'correctness-first-attempt',
            dependsOn,
            settledDependsOn: [],
            fixtureProfile: atomicReference(profile),
            stateAccessRef: null,
            resourceContractRef: atomicReference(resources),
            serviceDependencies: [],
            artifacts: ['attempt-payload'],
            evidence: ['attempt-receipt'],
            replayOwner: 'isolated-replay-owner',
            projectionOwner: 'isolated-projection-owner',
            replayPlanRef: { id: replay.id, contentDigest: sha256(replay.bytes), planDigest: plan.planDigest }
        };
        authorities.commandSources.push(source);
        authorities.inputClosures.push(closure);
        authorities.replayPlans.push(replay);
        authorities.physicalOwnership.push({
            producerId: id,
            logicalParentId: node.logicalParentId,
            owner: node.owner,
            commandSourceRef: node.commandSourceRef
        });
        return node;
    });
    const coordination = {
        logicalParentId: 'fixture-summary',
        owner: 'isolated-projection-owner',
        projectionOwner: 'isolated-projection-owner',
        dependsOn: []
    };
    const matrix = {
        tiers: [{
            id: 'fixture-summary',
            executionMode: 'projection',
            commandKind: 'projection',
            executionOwner: 'isolated-projection-owner',
            projectFrom: ['alpha-check', 'beta-check', 'dependent-check']
        }],
        atomicProducerDeclarations: {
            schema: 'fsusblog.atomic-producer-declarations.v1',
            nodes: [
                ...producers,
                { ...coordination, kind: 'settled-join', producerId: 'settled-observer', settledDependsOn: ['alpha-check', 'beta-check'] },
                { ...coordination, kind: 'logical-projection', producerId: 'fixture-summary', settledDependsOn: ['alpha-check', 'beta-check', 'dependent-check'] },
                {
                    ...coordination,
                    kind: 'always-run-finalizer',
                    producerId: 'cleanup-inventory',
                    settledDependsOn: ['alpha-check', 'beta-check', 'dependent-check', 'fixture-summary', 'settled-observer'],
                    finalizerPurpose: 'cleanup',
                    operationRef: atomicReference(finalizer)
                }
            ]
        }
    };
    return { matrix, authorities: { ...authorities, matrixDigest: digestCanonical(matrix) } };
}

export function rebindAtomicFixture(fixture)
{
    fixture.authorities.matrixDigest = digestCanonical(fixture.matrix);
    return fixture;
}

export function atomicExecutionOptions(fixture, evidenceRoot, { signalByProducer = {}, onCleanup = () =>
{} } = {})
{
    const context = {
        evidenceRoot,
        schedulerRunId: 'isolated-atomic-run',
        sourceCommit: '1'.repeat(40),
        worktreeFingerprint: `sha256:${'2'.repeat(64)}`
    };
    const producerContexts = Object.fromEntries(fixture.authorities.replayPlans.map((replay) =>
    {
        const references = [
            ['execution-envelope', `sha256:${'3'.repeat(64)}`],
            ['replay-plan', sha256(replay.bytes)],
            ['temporal-context', `sha256:${'5'.repeat(64)}`]
        ].map(([kind, artifactDigest]) => ({
            kind,
            artifactPath: kind === 'replay-plan' ? replay.artifactPath : `${kind}.json`,
            artifactDigest,
            verificationReceiptPath: `${kind}.verification.json`,
            verificationReceiptDigest: `sha256:${'6'.repeat(64)}`
        }));
        return [replay.plan.producer.id, {
            cwd: repositoryRoot,
            env: { PATH: process.env.PATH },
            timeoutMs: 5000,
            signal: signalByProducer[replay.plan.producer.id],
            authorityReferences: references,
            verifyAuthority: (reference) => ({
                verified: true,
                authorityDigest: reference.artifactDigest,
                verificationReceiptDigest: reference.verificationReceiptDigest,
                identity: {
                    sourceCommit: context.sourceCommit,
                    worktreeFingerprint: context.worktreeFingerprint,
                    schedulerRunId: context.schedulerRunId,
                    producerId: replay.plan.producer.id
                }
            })
        }];
    }));
    const operation = fixture.authorities.finalizerOperations[0];
    return {
        ...fixture,
        context,
        capacity: { maxParallel: 2, cpuUnits: 2, memoryGiB: 2 },
        producerContexts,
        finalizerOperations: { [operation.id]: { contentDigest: operation.contentDigest, execute: onCleanup } }
    };
}
