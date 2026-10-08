import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { coverageCompilerFixture } from './atomic-coverage-compiler-fixtures.mjs';
import { atomicExecutionOptions, atomicFixture as originalAtomicFixture, rebindAtomicFixture } from './atomic-producer-fixture.mjs';
import { backendCompilerFixture } from './backend-atomic-compiler-fixture.mjs';
import { publicRuntimeCompilerFixture } from './public-runtime-compiler-fixture.mjs';
import { staticAtomicCanonicalFixture } from './static-atomic-canonical-fixture.mjs';

const { canonicalTestId, planExactShards, sealReplayPlan } = await import(new URL('../../../tools/test/execution-replay-contract.mjs', import.meta.url));
const { digestCanonical, sha256 } = await import(new URL('../../../tools/test/attempt-provenance.mjs', import.meta.url));
const { compileAtomicProducerDag } = await import(new URL('../../../tools/test-matrix/atomic-producers/compiler.mjs', import.meta.url));

export const hostLimits = Object.freeze({ maxDepth: 40, maxNodes: 20000, maxBytes: 2000000, maxItems: 10000 });
export const repositoryRoot = '/workspace/FsusBlog';

export function fixtureReference(name, context)
{
    return { path: `.tmp/test-runs/${context.schedulerRunId}/${name}.json`, objectDigest: digestCanonical(name) };
}

export function atomicFixture()
{
    const context = { schedulerRunId: 'atomic-fixture', attemptId: 'attempt-one', sourceCommit: 'a'.repeat(40),
        worktreeFingerprint: digestCanonical('worktree') };
    const node = (id, kind = 'producer', dependsOn = [], settledDependsOn = []) => ({ id,
        logicalParentId: 'fixture-parent', kind, evidenceClass: ['settled-join', 'finalizer'].includes(kind) ? 'coordination' : 'correctness',
        dependsOn, settledDependsOn, ciJobId: id === 'failure-a' || id === 'independent-success' ? 'shared-runner' : id,
        stateAccess: [], exclusiveResources: [] });
    const nodes = [node('failure-a'), node('failure-b'), node('dependent', 'producer', ['failure-a']),
        node('dependent-transitive', 'producer', ['dependent']), node('independent-success'),
        node('settled-summary', 'settled-join', [], ['failure-a', 'failure-b']),
        node('cleanup', 'finalizer', [], ['settled-summary', 'dependent-transitive', 'independent-success'])];
    const graph = { graphRef: fixtureReference('compiled-graph', context), dagDigest: digestCanonical(nodes), nodes };
    const terminals = nodes.map((entry) =>
    {
        const failed = entry.id.startsWith('failure-');
        const blocked = entry.id.startsWith('dependent');
        const coordination = entry.evidenceClass === 'coordination';
        const terminalState = failed ? 'failed' : blocked ? 'blocked' : entry.id === 'settled-summary' ? 'failed' : 'success';
        let replayPlan = null;
        if (failed)
        {
            const testIds = [canonicalTestId({ framework: 'vitest', source: 'tests/atomic.test.ts', name: entry.id })];
            const shards = planExactShards({ testIds, shardCount: 1 });
            replayPlan = sealReplayPlan({ schema: 'fsusblog.test-execution-replay-plan.v1',
                source: { commit: context.sourceCommit, worktreeFingerprint: context.worktreeFingerprint },
                producer: { id: entry.id, framework: 'vitest' }, run: { id: context.schedulerRunId, mode: 'qualification' },
                rootSeed: `seed256:${'77'.repeat(32)}`, entropySources: [{ id: 'root-seed', kind: 'root-seed', source: 'cli' }],
                randomStreams: [], testEnumerationOrder: shards.testEnumerationOrder,
                orderPolicy: { kind: 'canonical-utf8-bytewise', caseSensitivity: 'sensitive' },
                shards: shards.shards, shardPolicy: shards.shardPolicy,
                workers: { ids: ['worker-1', 'worker-2'], assignmentPolicy: 'framework-owned-after-seal' },
                frameworkModes: [{ name: 'pool', value: 'forks' }, { name: 'workers', value: '2' }],
                schedulerReadyPolicy: { kind: 'sealed-shard-order', dynamicReassignment: false },
                schedulerShuffleSeed: 'fixture-seed',
                command: { executable: process.execPath, args: ['--version'], environmentDigest: digestCanonical('environment') } });
        }
        return { producerId: entry.id, terminalState, reasonCode: blocked ? 'dependency-not-success' : failed ? 'product.assertion'
            : entry.id === 'settled-summary' ? 'dependency-terminal-failure' : null,
        failures: failed ? [{ kind: 'product.assertion', identity: { producerId: entry.id, assertionId: 'assertion-one' } }] : [],
        primaryFailureRefs: failed ? [fixtureReference(`${entry.id}/primary`, context)]
            : entry.id === 'settled-summary' ? ['failure-a', 'failure-b'].map((id) => fixtureReference(`${id}/primary`, context)) : [],
        blockedBy: blocked ? ['failure-a'] : [],
        attemptReceiptRef: blocked || coordination ? null : fixtureReference(`${entry.id}/attempt`, context),
        attemptNumber: blocked || coordination ? 0 : 1, allowedRetries: 0,
        replayPlanRef: replayPlan ? { ...fixtureReference(`${entry.id}/replay`, context), objectDigest: replayPlan.planDigest } : null,
        replayPlan, executionEnvelopeDigest: digestCanonical('envelope'),
        logRefs: failed ? [fixtureReference(`${entry.id}/log`, context)] : [], artifactRefs: [], evidenceRefs: [] };
    });
    const launches = nodes.filter((entry) => entry.evidenceClass !== 'coordination').map((entry, index) => ({
        location: { path: 'tools/fixture.mjs', line: index + 1, column: 1 }, parentId: entry.id,
        childId: `${entry.id}-command`, producerId: entry.id, owner: 'fixture-owner', migrationEntry: 'fixture-entry',
        dynamic: false, failureMode: 'fail-closed', role: 'correctness', descendantProof: null }));
    return structuredClone({ context, graph, aggregateRef: fixtureReference('aggregate', context), terminals, launches });
}

/** Controlled attachments from original lane helpers; never production matrix or qualification. */
export function originalLaneFixture(t, kind, scenarios = {})
{
    let lane;
    let identity;
    let frontendContext;
    let publicRuntimeContext;
    let coverageContext;
    if (kind === 'backend')
    {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-lane-backend-'));
        t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
        const fixture = backendCompilerFixture(directory);
        lane = { id: 'backend-source', kind, input: fixture.input, options: {} };
        identity = fixture.options.context;
    }
    else if (kind === 'static')
    {
        const fixture = staticAtomicCanonicalFixture(t);
        const { repositoryRoot: sourceRoot, matrix, authorities, memberships, prerequisiteBindings } = fixture.options;
        lane = { id: 'static-source', kind, input: { repositoryRoot: sourceRoot, matrix, authorities, memberships, prerequisiteBindings }, options: {} };
        identity = fixture.options.context;
    }
    else if (kind === 'public-runtime')
    {
        const fixture = publicRuntimeCompilerFixture('load');
        t.after(fixture.cleanup);
        const { declarations, attachment, authorities, matrix } = fixture;
        lane = { id: 'public-source', kind, input: { declarations, attachment, authorities, matrix }, options: fixture.compilerOptions };
        identity = fixture.context;
        publicRuntimeContext = fixture;
    }
    else if (kind === 'coverage')
    {
        const fixture = coverageCompilerFixture(t, scenarios);
        const { root, plan, requests, matrix, authorities } = fixture;
        lane = { id: 'coverage-source', kind, input: { root, plan, requests, matrix, authorities }, options: {} };
        identity = fixture.executionOptions.context;
        coverageContext = fixture.executionOptions;
    }
    else
    {
        const fixture = originalAtomicFixture(scenarios);
        const groupId = 'frontend-source-fixture';
        fixture.matrix.tiers[0].id = groupId;
        fixture.matrix.atomicProducerDeclarations.nodes.forEach((node) => node.logicalParentId = groupId);
        fixture.authorities.physicalOwnership.forEach((owner) => owner.logicalParentId = groupId);
        fixture.matrix.tiers[0].executionDependsOn = [];
        fixture.matrix.commandGroups = { [groupId]: { lane: groupId, schema: 'fsusblog.test-command-manifest.v1',
            commands: fixture.authorities.physicalOwnership.map((entry) =>
            {
                const node = fixture.matrix.atomicProducerDeclarations.nodes.find((item) => item.producerId === entry.producerId);
                return { id: node.producerId, command: fixture.authorities.commandSources.find((item) => item.id === node.commandSourceRef.id).command,
                    access: 'read', consumedInputs: ['tests/tools/support/atomic-producer-command.mjs'],
                    resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 },
                    dependsOn: node.dependsOn, settledDependsOn: node.settledDependsOn };
            }) } };
        rebindAtomicFixture(fixture);
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-lane-frontend-'));
        t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
        frontendContext = atomicExecutionOptions(fixture, directory);
        lane = { id: 'frontend-source', kind, input: { compiled: compileAtomicProducerDag(fixture.matrix, fixture.authorities),
            matrix: fixture.matrix, authorities: fixture.authorities, groupId }, options: {} };
        identity = frontendContext.context;
    }
    return { lane, identity, frontendContext, publicRuntimeContext, coverageContext };
}

/** Align only synthetic replay identities; original commands, membership and resource sources remain untouched. */
export function composeOriginalLaneFixtures(fragments)
{
    const identity = fragments[0].identity;
    const collections = ['physicalOwnership', 'commandSources', 'inputClosures', 'fixtureProfiles', 'replayPlans',
        'resourceContracts', 'stateAccess', 'finalizerOperations'];
    const authorities = Object.fromEntries(collections.map((field) => [field, []]));
    const matrix = { tiers: [], atomicProducerDeclarations: { schema: 'fsusblog.atomic-producer-declarations.v1', nodes: [] } };
    const frontendContexts = {};
    for (const fragment of fragments)
    {
        const { lane } = fragment;
        const input = lane.input;
        for (const replay of input.authorities.replayPlans)
        {
            const plan = replay.plan ?? JSON.parse(replay.bytes);
            if (plan.source.commit === identity.sourceCommit
                && plan.source.worktreeFingerprint === identity.worktreeFingerprint
                && plan.run.id === identity.schedulerRunId)
            {
                continue;
            }
            const { planDigest, ...unsigned } = plan;
            if (!planDigest)
            {
                throw new Error('original fixture replay digest required');
            }
            replay.plan = sealReplayPlan({ ...unsigned, source: { commit: identity.sourceCommit, worktreeFingerprint: identity.worktreeFingerprint },
                run: { ...unsigned.run, id: identity.schedulerRunId } });
            replay.bytes = `${JSON.stringify(replay.plan, null, 4)}\n`;
            for (const node of input.matrix.atomicProducerDeclarations.nodes.filter((entry) => entry.replayPlanRef?.id === replay.id))
            {
                node.replayPlanRef.contentDigest = sha256(replay.bytes);
                node.replayPlanRef.planDigest = replay.plan.planDigest;
            }
            for (const binding of Object.values(input.attachment?.producers ?? {}).filter((entry) => entry.replayPlanRef.id === replay.id))
            {
                binding.replayPlanRef.contentDigest = sha256(replay.bytes);
                binding.replayPlanRef.planDigest = replay.plan.planDigest;
            }
        }
        input.authorities.matrixDigest = digestCanonical(input.matrix);
        if (lane.kind === 'frontend')
        {
            input.compiled = compileAtomicProducerDag(input.matrix, input.authorities);
            const context = { ...fragment.frontendContext.context, schedulerRunId: identity.schedulerRunId,
                sourceCommit: identity.sourceCommit, worktreeFingerprint: identity.worktreeFingerprint };
            const producerContexts = Object.fromEntries(Object.entries(fragment.frontendContext.producerContexts).map(([producerId, supplied]) =>
            {
                const replay = input.authorities.replayPlans.find((entry) => entry.plan.producer.id === producerId);
                const authorityReferences = supplied.authorityReferences.map((reference) => reference.kind === 'replay-plan'
                    ? { ...reference, artifactDigest: sha256(replay.bytes) } : reference);
                return [producerId, { ...supplied, authorityReferences, verifyAuthority: (reference) => ({
                    verified: true, authorityDigest: reference.artifactDigest, verificationReceiptDigest: reference.verificationReceiptDigest,
                    identity: { sourceCommit: context.sourceCommit, worktreeFingerprint: context.worktreeFingerprint,
                        schedulerRunId: context.schedulerRunId, producerId } }) }];
            }));
            frontendContexts[lane.id] = { context, producerContexts };
        }
        matrix.tiers.push(...input.matrix.tiers);
        matrix.atomicProducerDeclarations.nodes.push(...input.matrix.atomicProducerDeclarations.nodes);
        if (input.matrix.commandGroups)
        {
            matrix.commandGroups = { ...matrix.commandGroups, ...input.matrix.commandGroups };
        }
        for (const field of collections)
        {
            authorities[field].push(...input.authorities[field]);
        }
    }
    authorities.matrixDigest = digestCanonical(matrix);
    const compiled = compileAtomicProducerDag(matrix, authorities);
    return { material: { compiled, matrix, authorities, lanes: fragments.map((fragment) => fragment.lane),
        context: { schedulerRunId: identity.schedulerRunId, attemptId: 'first-attempt', sourceCommit: identity.sourceCommit },
        worktreeFingerprint: identity.worktreeFingerprint,
        ciPlan: { jobs: [{ id: 'original-shared-runner', tiers: matrix.tiers.map((tier) => tier.id) }] },
        graphRef: { path: `.tmp/test-runs/${identity.schedulerRunId}/graph.json`, objectDigest: compiled.contentDigest },
        selectedIds: compiled.steps.map((step) => step.id) }, frontendContexts };
}
