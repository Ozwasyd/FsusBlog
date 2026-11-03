import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { URL } from 'node:url';

const { digestCanonical, sealContentDigest, sha256 } = await import(new URL('../../../tools/test/attempt-provenance.mjs', import.meta.url));
const { canonicalTestId, planExactShards, REPLAY_PLAN_SCHEMA, sealReplayPlan } = await import(new URL('../../../tools/test/execution-replay-contract.mjs', import.meta.url));
const { buildPublicRuntimeDeclarations } = await import(new URL('../../../tools/test/public-runtime-producers/declarations.mjs', import.meta.url));
const { publicRuntimeAtomicNodes, publicRuntimeProducerCommand } = await import(new URL('../../../tools/test/public-runtime-producers/compiler-adapter.mjs', import.meta.url));
const { publicRuntimeSettledResetContract } = await import(new URL('../../../tools/test/public-runtime-producers/settled-reset-adapter.mjs', import.meta.url));

const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
const sharedCommandFixture = path.join(repositoryRoot, 'tests/tools/support/atomic-producer-command.mjs');
const reference = (material) => ({ id: material.id, contentDigest: material.contentDigest });

/** Ordinary synthetic source fixture, never product runtime or upstream proof. */
export function publicRuntimeCompilerFixture(tier, { aotScenario = 'success' } = {})
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'public-runtime-source-'));
    const original = buildPublicRuntimeDeclarations(tier);
    for (const source of original.sources)
    {
        const destination = path.join(root, source.path);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(path.join(repositoryRoot, source.path), destination);
    }
    if (tier === 'release-public')
    {
        const script = `process.argv[2] = process.env.PUBLIC_RUNTIME_FIXTURE_SCENARIO;\n`
            + `process.argv[3] = process.env.PUBLIC_RUNTIME_FIXTURE_TEST_ID;\n`
            + `await import(${JSON.stringify(new URL(`file://${sharedCommandFixture}`).href)});\n`;
        for (const source of original.sources.filter((entry) => entry.path.startsWith('tests/frontend/checks/public/')))
        {
            fs.writeFileSync(path.join(root, source.path), script);
        }
        fs.writeFileSync(path.join(root, 'src/frontend/package.json'), JSON.stringify({
            type: 'module', private: true,
            scripts: { 'check:public-seo-smoke': 'node ../../tests/frontend/checks/public/aot-regression.mjs' }
        }));
    }
    const declarations = buildPublicRuntimeDeclarations(tier, { root });
    const children = declarations.nodes.filter((node) => node.kind !== 'settled-projection');
    const identity = {
        runId: 'public-runtime-source-fixture', sourceCommit: 'a'.repeat(40), sourceFingerprint: sha256('source-fixture'),
        candidateDigest: sha256('fixture-candidate'), buildDigest: sha256('fixture-build'), manifestDigest: sha256('fixture-manifest'),
        runtimeIdentityDigest: sha256('fixture-runtime'), backendUrl: 'http://127.0.0.1:7568', previewUrl: 'http://127.0.0.1:8080'
    };
    const context = { evidenceRoot: path.join(root, 'evidence'), schedulerRunId: identity.runId,
        sourceCommit: identity.sourceCommit, worktreeFingerprint: identity.sourceFingerprint };
    const authorities = {
        physicalOwnership: [], commandSources: [], inputClosures: [], fixtureProfiles: [], replayPlans: [],
        resourceContracts: [], stateAccess: [], finalizerOperations: []
    };
    const profile = sealContentDigest({ id: 'source-fixture-profile', fixtureKind: 'synthetic-source-only' });
    const resources = sealContentDigest({ id: 'source-fixture-resources', resources: { minCpuUnits: 1, cpuWeight: 1, memoryWeight: 1 } });
    authorities.fixtureProfiles.push(profile);
    authorities.resourceContracts.push(resources);
    const attachment = { logicalParentId: `${tier}-source-parent`, projectionOwner: 'public-runtime-source-projection',
        declarationDigest: declarations.contentDigest, producers: {} };
    const producerContexts = {};
    const add = (id, command, logicalParentId, environment, execution = null) =>
    {
        const closure = sealContentDigest({ id: `${id}-inputs`, commandSourceId: `${id}-command`,
            commandDigest: digestCanonical(command), unresolvedDynamicReads: [] });
        const source = sealContentDigest({ id: `${id}-command`, command, executableAuthorityCount: 1,
            inputClosureRef: reference(closure), ...(execution === null ? {} : { publicRuntimeExecution: {
                producerId: id, declarationDigest: declarations.contentDigest, execution
            } }) });
        const state = sealContentDigest({ id: `${id}-state`, producerId: id, unknownAccess: false, requiredPredecessors: [] });
        const testId = canonicalTestId({ framework: 'node-test', source: 'tests/tools/public-runtime-producer-compiler-adapter.test.mjs', name: ['source-fixture', id] });
        const env = { PATH: process.env.PATH, npm_config_cache: path.join(root, 'npm-cache'),
            npm_config_update_notifier: 'false', ...environment,
            PUBLIC_RUNTIME_FIXTURE_TEST_ID: testId,
            PUBLIC_RUNTIME_FIXTURE_SCENARIO: id === 'public-aot-regression' ? aotScenario : 'success' };
        const plan = sealReplayPlan({
            schema: REPLAY_PLAN_SCHEMA,
            source: { commit: context.sourceCommit, worktreeFingerprint: context.worktreeFingerprint },
            producer: { id, framework: 'node-test' }, run: { id: context.schedulerRunId, mode: 'diagnostic' },
            rootSeed: `seed256:${'ab'.repeat(32)}`,
            entropySources: [{ id: 'root-seed', kind: 'root-seed', source: 'cli' }], randomStreams: [],
            ...planExactShards({ testIds: [testId], shardCount: 1 }),
            workers: { ids: ['source-fixture-worker'], assignmentPolicy: 'framework-owned-after-seal' },
            frameworkModes: [{ name: 'retry', value: 'disabled' }],
            schedulerReadyPolicy: { kind: 'sealed-shard-order', dynamicReassignment: false },
            schedulerShuffleSeed: 'source-fixture-order',
            command: { executable: command[0], args: command.slice(1), environmentDigest: digestCanonical(env) }
        });
        const bytes = `${JSON.stringify(plan, null, 4)}\n`;
        const artifactPath = path.join(root, `${id}.replay-plan.json`);
        fs.writeFileSync(artifactPath, bytes);
        const replay = { id: `${id}-replay`, replayOwner: 'source-fixture-replay-owner',
            fixtureProfileDigest: profile.contentDigest, artifactPath, bytes };
        const binding = { owner: 'public-runtime-source-owner', commandSourceRef: reference(source),
            fixtureProfile: reference(profile), stateAccessRef: reference(state), resourceContractRef: reference(resources),
            serviceDependencies: [], artifacts: ['attempt-payload'], evidence: ['attempt-receipt'],
            replayOwner: replay.replayOwner,
            replayPlanRef: { id: replay.id, contentDigest: sha256(bytes), planDigest: plan.planDigest } };
        authorities.commandSources.push(source);
        authorities.inputClosures.push(closure);
        authorities.stateAccess.push(state);
        authorities.replayPlans.push(replay);
        authorities.physicalOwnership.push({ producerId: id, logicalParentId,
            owner: binding.owner, commandSourceRef: binding.commandSourceRef });
        const authorityReferences = ['execution-envelope', 'replay-plan', 'temporal-context'].map((kind) => ({
            kind, artifactPath: kind === 'replay-plan' ? artifactPath : `${kind}.json`,
            artifactDigest: kind === 'replay-plan' ? sha256(bytes) : sha256(kind),
            verificationReceiptPath: `${kind}.verification.json`, verificationReceiptDigest: sha256(`${kind}-source-fixture`)
        }));
        producerContexts[id] = { cwd: path.join(root, 'src/frontend'), env, timeoutMs: 5000, authorityReferences,
            verifyAuthority: (ref) => ({ verified: true, authorityDigest: ref.artifactDigest,
                verificationReceiptDigest: ref.verificationReceiptDigest,
                identity: { ...context, producerId: id } }) };
        return binding;
    };
    for (const node of children)
    {
        const target = node.execution?.target ?? 'backend-and-preview';
        const base = target === 'preview' ? identity.previewUrl : identity.backendUrl;
        const environment = { FSUSBLOG_BASE_URL: base,
            FSUSBLOG_PUBLIC_BASE_URL: target === 'backend-and-preview' ? identity.previewUrl : base,
            FSUSBLOG_HTTP_TIMEOUT_MS: String(tier === 'load' ? 10000 : 15000), ...node.execution?.environment };
        const command = publicRuntimeProducerCommand(node, { root, nodeExecutable: process.execPath });
        const testId = canonicalTestId({ framework: 'node-test', source: 'tests/tools/public-runtime-producer-compiler-adapter.test.mjs', name: ['source-fixture', node.id] });
        attachment.producers[node.id] = add(node.id,
            command ?? [process.execPath, sharedCommandFixture, 'success', testId], attachment.logicalParentId, environment,
            command !== null ? null : node.execution ?? publicRuntimeSettledResetContract());
    }
    const prerequisiteParent = 'source-prerequisite-parent';
    const prerequisiteOwner = 'source-prerequisite-projection';
    const prerequisiteNodes = declarations.externalDependencies.map((id) =>
    {
        const testId = canonicalTestId({ framework: 'node-test', source: 'tests/tools/public-runtime-producer-compiler-adapter.test.mjs', name: ['source-fixture', id] });
        const binding = add(id, [process.execPath, sharedCommandFixture, 'success', testId], prerequisiteParent, {});
        return { kind: 'hard-prerequisite', producerId: id, logicalParentId: prerequisiteParent,
            projectionOwner: prerequisiteOwner, executionClass: 'static', evidenceClass: 'correctness',
            attemptPolicyId: 'correctness-first-attempt', dependsOn: [], settledDependsOn: [], ...binding };
    });
    const domain = publicRuntimeAtomicNodes({ declarations, attachment, authorities }, { root, nodeExecutable: process.execPath });
    const ids = prerequisiteNodes.map((node) => node.producerId).sort();
    const matrix = { tiers: [domain.parent, { id: prerequisiteParent, executionMode: 'projection', commandKind: 'projection',
        executionOwner: prerequisiteOwner, projectFrom: ids }],
    atomicProducerDeclarations: { schema: 'fsusblog.atomic-producer-declarations.v1', nodes: [
        ...domain.nodes, ...prerequisiteNodes,
        { kind: 'logical-projection', producerId: 'source-prerequisite-summary', logicalParentId: prerequisiteParent,
            owner: prerequisiteOwner, projectionOwner: prerequisiteOwner, dependsOn: [], settledDependsOn: ids }
    ] } };
    authorities.matrixDigest = digestCanonical(matrix);
    return {
        root, declarations, attachment, authorities, matrix, context, identity, producerContexts,
        timeoutProfiles: { release: 15000, resilience: 15000, load: 10000 },
        compilerOptions: { root, nodeExecutable: process.execPath },
        executionOptions: { matrix, authorities, context, producerContexts,
            capacity: { maxParallel: 3, cpuUnits: 3, memoryGiB: 3,
                stateConflictPolicy: { catalogDigest: sha256('synthetic-state-only'), evaluate: () => ({ conflict: false, conflicts: [] }) } } },
        cleanup: () => fs.rmSync(root, { recursive: true, force: true })
    };
}
