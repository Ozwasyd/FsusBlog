import path from 'node:path';
import { URL } from 'node:url';

import { staticAtomicFixture } from './static-atomic-fixture.mjs';

const { digestCanonical, sealContentDigest, sha256 } = await import(new URL('../../../tools/test/attempt-provenance.mjs', import.meta.url));
const { canonicalTestId, planExactShards, REPLAY_PLAN_SCHEMA, sealReplayPlan } = await import(new URL('../../../tools/test/execution-replay-contract.mjs', import.meta.url));
const { bindStaticAtomicCompilation, executeStaticAtomicCompilation } = await import(new URL('../../../tools/test/static-atomic/compiler-bridge.mjs', import.meta.url));

const reference = material => ({ id: material.id, contentDigest: material.contentDigest });

/** Synthetic owner attachments and original-shaped commands; never runtime admission or qualification. */
export function staticAtomicCanonicalFixture(t, { failures = [], blockedSupplyChain = false, resultSidecars = true } = {})
{
    const base = staticAtomicFixture(t, failures, { resultSidecars });
    const authorities = { physicalOwnership: [], commandSources: [], inputClosures: [], fixtureProfiles: [],
        replayPlans: [], resourceContracts: [], stateAccess: [], finalizerOperations: [] };
    const profile = sealContentDigest({ id: 'synthetic-static-profile', fixtureKind: 'test-only' });
    authorities.fixtureProfiles.push(profile);
    const memberships = Object.fromEntries(base.declarations.producers.map(producer =>
    {
        const testId = name => canonicalTestId({ framework: 'node-test',
            source: 'tests/tools/static-atomic-compiler-bridge.test.mjs', name: ['synthetic', producer.id, name] });
        return [producer.id, sealContentDigest({ schema: 'fsusblog.static-assertion-membership.v1', producerId: producer.id,
            legacyPhysicalTestIds: producer.legacyPhysicalTestIds,
            assertionBindings: producer.assertionBindings.map(binding => ({ ...binding, replayTestIds: [testId(binding.id)] })),
            additionalTestIds: producer.assertionBindings.length === 0 ? [testId('explicit-unregistered-check')] : [] })];
    }));
    const testIds = id => [...memberships[id].assertionBindings.flatMap(binding => binding.replayTestIds),
        ...memberships[id].additionalTestIds].sort();
    base.env.CONTROL_TEST_IDS = JSON.stringify(Object.fromEntries(base.declarations.producers.map(producer =>
        [producer.command.at(-1).split('/').at(-1), testIds(producer.id)])));
    const prerequisiteBindings = {};
    const contexts = {};
    const makeProducer = (id, command, resources, parent, owner, ids, dependsOn = [], producer = null) =>
    {
        const closure = sealContentDigest({ id: `${id}-inputs`, commandSourceId: `${id}-command`,
            commandDigest: digestCanonical(command), unresolvedDynamicReads: [] });
        const source = sealContentDigest({ id: `${id}-command`, command, executableAuthorityCount: 1,
            inputClosureRef: reference(closure) });
        const resource = sealContentDigest({ id: `${id}-resources`, resources });
        const plan = sealReplayPlan({ schema: REPLAY_PLAN_SCHEMA,
            source: { commit: base.identity.sourceCommit, worktreeFingerprint: base.identity.worktreeFingerprint },
            producer: { id, framework: 'node-test' }, run: { id: base.identity.schedulerRunId, mode: 'diagnostic' },
            rootSeed: `seed256:${'ab'.repeat(32)}`, entropySources: [{ id: 'root-seed', kind: 'root-seed', source: 'cli' }],
            randomStreams: [], ...planExactShards({ testIds: ids, shardCount: 1 }),
            workers: { ids: ['synthetic-static-worker'], assignmentPolicy: 'framework-owned-after-seal' },
            frameworkModes: [{ name: 'retry', value: 'disabled' }],
            schedulerReadyPolicy: { kind: 'sealed-shard-order', dynamicReassignment: false },
            schedulerShuffleSeed: 'synthetic-static-order',
            command: { executable: command[0], args: command.slice(1), environmentDigest: digestCanonical(base.env) } });
        const replay = { id: `${id}-replay`, replayOwner: 'synthetic-replay-owner',
            fixtureProfileDigest: profile.contentDigest, artifactPath: `synthetic/${id}/replay.json`,
            bytes: `${JSON.stringify(plan, null, 4)}\n`, plan };
        const replayPlanRef = { id: replay.id, contentDigest: sha256(replay.bytes), planDigest: plan.planDigest };
        const node = { kind: producer ? 'atomic-producer' : 'hard-prerequisite', producerId: id,
            logicalParentId: parent, owner, projectionOwner: 'synthetic-projection-owner',
            commandSourceRef: reference(source), executionClass: 'static', evidenceClass: 'correctness',
            attemptPolicyId: 'correctness-first-attempt', dependsOn, settledDependsOn: [],
            fixtureProfile: reference(profile), stateAccessRef: null, resourceContractRef: reference(resource),
            serviceDependencies: [], artifacts: [], evidence: ['attempt-receipt'],
            replayOwner: replay.replayOwner, replayPlanRef };
        authorities.commandSources.push(source);
        authorities.inputClosures.push(closure);
        authorities.resourceContracts.push(resource);
        authorities.replayPlans.push(replay);
        authorities.physicalOwnership.push({ producerId: id, logicalParentId: parent, owner, commandSourceRef: node.commandSourceRef });
        const references = base.references(id).map(entry => entry.kind === 'replay-plan'
            ? { ...entry, artifactPath: replay.artifactPath, artifactDigest: replayPlanRef.contentDigest } : entry);
        const proofs = new Map(references.map(entry => [entry.artifactDigest, {
            verified: true, authorityDigest: entry.artifactDigest, verificationReceiptDigest: entry.verificationReceiptDigest,
            identity: { ...base.identity, producerId: id },
            ...(producer ? { staticAtomic: {
                declarationDigest: base.declarations.contentDigest, inputClosureDigest: closure.contentDigest,
                commandDigest: digestCanonical(command), environmentDigest: digestCanonical(base.env),
                resourceContractDigest: digestCanonical(resources), prerequisiteSetDigest: digestCanonical(producer.prerequisites),
                cwd: path.resolve(base.root, producer.cwd), network: producer.network, networkEnforced: true,
                networkPolicyDigest: digestCanonical('synthetic-network-policy')
            } } : {})
        }]));
        contexts[id] = { cwd: path.resolve(base.root, producer?.cwd ?? '.'), env: base.env, timeoutMs: 5000,
            authorityReferences: references, verifyAuthority: entry => proofs.get(entry.artifactDigest) };
        if (producer)
        {
            prerequisiteBindings[id] = Object.fromEntries(producer.prerequisites.map(capability => [capability,
                dependsOn.length ? { kind: 'hard-prerequisite', producerId: dependsOn[0] }
                    : { kind: 'held-input', inputClosureRef: node.inputClosureRef ?? reference(closure) }]));
        }
        return node;
    };
    const nodes = base.declarations.producers.map(producer => makeProducer(producer.id, producer.command, producer.resources,
        producer.lane, producer.canonicalExecutionOwner?.split('/')[0] ?? 'synthetic-static-owner', testIds(producer.id),
        blockedSupplyChain && producer.id === 'security-supply-chain-audit' ? ['synthetic-restore'] : [], producer));
    if (blockedSupplyChain)
    {
        const id = canonicalTestId({ framework: 'node-test', source: 'tests/tools/static-atomic-compiler-bridge.test.mjs', name: ['synthetic-restore'] });
        nodes.push(makeProducer('synthetic-restore', [process.execPath, '-e', 'process.exit(19)'],
            { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 }, 'static-prerequisites', 'synthetic-restore-owner', [id]));
    }
    const tiers = ['cross-stack-static', 'security-static', ...(blockedSupplyChain ? ['static-prerequisites'] : [])].map(lane =>
    {
        const ids = nodes.filter(entry => entry.logicalParentId === lane).map(entry => entry.producerId).sort();
        nodes.push({ kind: 'logical-projection', producerId: `${lane}-summary`, logicalParentId: lane,
            owner: 'synthetic-projection-owner', projectionOwner: 'synthetic-projection-owner', dependsOn: [], settledDependsOn: ids });
        return { id: lane, executionMode: 'projection', commandKind: 'projection',
            executionOwner: 'synthetic-projection-owner', projectFrom: ids };
    });
    const matrix = { tiers, atomicProducerDeclarations: { schema: 'fsusblog.atomic-producer-declarations.v1', nodes } };
    authorities.matrixDigest = digestCanonical(matrix);
    const options = { repositoryRoot: base.root, matrix, authorities, memberships, prerequisiteBindings,
        context: { ...base.identity, evidenceRoot: base.evidenceRoot }, producerContexts: contexts,
        capacity: { maxParallel: 4, cpuUnits: 8, memoryGiB: 8 }, finalizerOperations: {} };
    const compilation = bindStaticAtomicCompilation(options);
    const execute = async () =>
    {
        try
        {
            return await executeStaticAtomicCompilation(compilation, options);
        }
        catch (error)
        {
            if (!error.terminalVector)
            {
                throw error;
            }
            return error.terminalVector;
        }
    };
    return { ...base, options, compilation, memberships, execute };
}
