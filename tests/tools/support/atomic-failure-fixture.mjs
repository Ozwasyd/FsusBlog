const { canonicalTestId, planExactShards, sealReplayPlan } = await import(new URL('../../../tools/test/execution-replay-contract.mjs', import.meta.url));
const { digestCanonical } = await import(new URL('../../../tools/test/attempt-provenance.mjs', import.meta.url));

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
