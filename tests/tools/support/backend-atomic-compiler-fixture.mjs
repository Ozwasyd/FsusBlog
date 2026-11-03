import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';

import { fixtureCommandFor, fixtureIdentity, fixtureInput } from './backend-atomic-fixture.mjs';

const { digestCanonical, sealContentDigest, sha256 } = await import(new URL('../../../tools/test/attempt-provenance.mjs', import.meta.url));
const { createBackendAtomicPlan } = await import(new URL('../../../tools/test/backend-atomic-producers.mjs', import.meta.url));
const { backendGovernanceInput, backendReadinessInput, projectBackendGovernanceOutcomes } = await import(new URL('../../../tools/test/backend-atomic-outcomes.mjs', import.meta.url));
const { canonicalTestId, planExactShards, REPLAY_PLAN_SCHEMA, sealReplayPlan } = await import(new URL('../../../tools/test/execution-replay-contract.mjs', import.meta.url));

const root = path.resolve(import.meta.dirname, '../../..');
const helperFile = new URL('./backend-atomic-compiler-fixture.mjs', import.meta.url).href;
const reference = (material) => ({ id: material.id, contentDigest: material.contentDigest });

/** Explicit test double; canonical source execution here is not native qualification. */
export function verifyCompilerFixtureAuthority(ref)
{
    const producerId = ref.artifactPath.split('/')[0];
    return { verified: true, authorityDigest: ref.artifactDigest, verificationReceiptDigest: ref.verificationReceiptDigest,
        identity: { ...fixtureIdentity, producerId } };
}

export function writeCompilerFixtureInput(kind, file, exitCode)
{
    const configuration = JSON.parse(fs.readFileSync(file));
    let artifact;
    let outcome = exitCode;
    if (kind === 'governance')
    {
        const plan = configuration.plans.find((entry) => entry.lane === 'backend-test-governance');
        const observations = plan.declarations.filter((entry) => entry.kind === 'atomic-producer').map((entry) =>
        {
            const relative = `${plan.identity.schedulerRunId}/${entry.producerId}/attempt-1/receipt.json`;
            return { producerId: entry.producerId, attemptRef: { path: relative, digest: sha256(fs.readFileSync(path.join(configuration.evidenceRoot, relative))) } };
        });
        const summary = projectBackendGovernanceOutcomes({ plan, expectedPlanDigest: plan.contentDigest, observations,
            evidenceRoot: configuration.evidenceRoot, sourceRoot: root, verifyAuthority: verifyCompilerFixtureAuthority });
        artifact = backendGovernanceInput(summary, observations);
        outcome = summary.exitCode;
    }
    else
    {
        artifact = backendReadinessInput(configuration.plans.find((entry) => entry.lane === 'backend-perf'));
    }
    const name = kind === 'governance' ? 'governance-input.json' : 'readiness-input.json';
    fs.writeFileSync(path.join(process.env.FSUSBLOG_ATTEMPT_ARTIFACT_ROOT, name), JSON.stringify(artifact));
    fs.writeFileSync(process.env.FSUSBLOG_ATTEMPT_RESULT_PATH, JSON.stringify({
        schema: 'fsusblog.test-attempt-result.v1', failureClass: outcome ? 'product' : null,
        failureKind: outcome ? 'assertion-mismatch' : null, failedTestIds: [], executedTestIds: [], artifactPaths: [name]
    }));
    process.exitCode = outcome;
}

/** Synthetic upstream projections exercise our actual canonical compiler/runner bridge. */
export function backendCompilerFixture(evidenceRoot, { perf = false, mode = 'build', failures = [], missingSidecar = null } = {})
{
    const inputs = [fixtureInput()];
    if (perf)
    {
        inputs.push(fixtureInput('backend-perf', mode));
    }
    const authorities = { physicalOwnership: [], commandSources: [], inputClosures: [], fixtureProfiles: [], replayPlans: [], resourceContracts: [], stateAccess: [], finalizerOperations: [] };
    const nodes = [];
    const tiers = [];
    const producerContexts = {};
    const configurationFile = path.join(evidenceRoot, 'compiler-fixture-input.json');
    for (const input of inputs)
    {
        const executable = input.declarations.filter((entry) => entry.kind === 'atomic-producer');
        const all = [...executable, ...(input.releasePrerequisite ? [input.releasePrerequisite] : [])];
        for (const declaration of all)
        {
            const id = declaration.producerId;
            const scenario = failures.includes(id) ? 'product-failure' : 'success';
            let command = fixtureCommandFor(scenario);
            if (['backend-perf-governance', 'backend-perf-readiness'].includes(id))
            {
                const kind = id === 'backend-perf-governance' ? 'governance' : 'readiness';
                command = [process.execPath, '--input-type=module', '-e', `const {writeCompilerFixtureInput}=await import(${JSON.stringify(helperFile)}); writeCompilerFixtureInput(${JSON.stringify(kind)},process.argv[1],Number(process.argv[2]));`, configurationFile, String(failures.includes(id) ? 1 : 0)];
            }
            if (id === missingSidecar)
            {
                command = [process.execPath, '-e', 'console.log("exit zero without an owner sidecar")'];
            }
            const env = input.lane === 'backend-perf' ? { PATH: process.env.PATH, FSUSBLOG_BACKEND_TEST_CONFIGURATION: 'Release', FSUSBLOG_BACKEND_PERF_READINESS_MODE: mode } : { PATH: process.env.PATH };
            const testId = canonicalTestId({ framework: 'node-test', source: 'tests/tools/backend-atomic-bridge.test.mjs', name: ['compiler-bridge-fixture', id] });
            const replayPlan = sealReplayPlan({ schema: REPLAY_PLAN_SCHEMA,
                source: { commit: fixtureIdentity.sourceCommit, worktreeFingerprint: fixtureIdentity.worktreeFingerprint },
                producer: { id, framework: 'node-test' }, run: { id: fixtureIdentity.schedulerRunId, mode: 'diagnostic' },
                rootSeed: `seed256:${'ab'.repeat(32)}`, entropySources: [{ id: 'root-seed', kind: 'root-seed', source: 'cli' }], randomStreams: [],
                ...planExactShards({ testIds: [testId], shardCount: 1 }), workers: { ids: ['fixture-worker'], assignmentPolicy: 'framework-owned-after-seal' },
                frameworkModes: [{ name: 'retry', value: 'disabled' }], schedulerReadyPolicy: { kind: 'sealed-shard-order', dynamicReassignment: false },
                schedulerShuffleSeed: 'fixture-fixed', command: { executable: command[0], args: command.slice(1), environmentDigest: digestCanonical(env) } });
            const replay = { id: `${id}-replay`, replayOwner: 'fixture-replay-owner', artifactPath: `${id}/replay-plan.json`, bytes: `${JSON.stringify(replayPlan)}\n` };
            const profile = sealContentDigest({ id: `${id}-fixture`, profileId: 'none' });
            replay.fixtureProfileDigest = profile.contentDigest;
            const closure = sealContentDigest({ id: `${id}-closure`, commandSourceId: `${id}-command`, commandDigest: digestCanonical(command), unresolvedDynamicReads: [], sourceRef: declaration.inputClosureRef });
            const source = sealContentDigest({ id: `${id}-command`, command, executableAuthorityCount: 1, inputClosureRef: reference(closure), sourceRef: declaration.commandSourceRef });
            const native = id === 'backend-perf-native-p99';
            const build = id === 'backend-perf-readiness' || id === input.releasePrerequisite?.producerId;
            const resources = sealContentDigest({ id: `${id}-resources`, sourceRef: declaration.resourceContractRef,
                resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1, ...(native ? { exclusiveResources: ['benchmark-window'] } : {}) } });
            const state = sealContentDigest({ id: `${id}-state`, producerId: id, unknownAccess: false, sourceRef: declaration.stateAccessRef });
            const node = { kind: id === input.releasePrerequisite?.producerId ? 'hard-prerequisite' : 'atomic-producer', producerId: id,
                logicalParentId: declaration.logicalParentId, owner: 'fixture-backend-owner', projectionOwner: 'fixture-projection-owner',
                commandSourceRef: reference(source), executionClass: native ? 'runtime' : build ? 'build' : 'static', evidenceClass: 'correctness',
                attemptPolicyId: 'correctness-first-attempt', dependsOn: declaration.dependsOn, settledDependsOn: declaration.settledDependsOn,
                fixtureProfile: reference(profile), stateAccessRef: native ? reference(state) : null, resourceContractRef: reference(resources), serviceDependencies: [],
                artifacts: ['attempt-result'], evidence: ['attempt-receipt'], replayOwner: replay.replayOwner,
                replayPlanRef: { id: replay.id, contentDigest: sha256(replay.bytes), planDigest: replayPlan.planDigest } };
            nodes.push(node);
            authorities.physicalOwnership.push({ producerId: id, logicalParentId: declaration.logicalParentId, owner: node.owner, commandSourceRef: node.commandSourceRef });
            authorities.commandSources.push(source);
            authorities.inputClosures.push(closure);
            authorities.fixtureProfiles.push(profile);
            authorities.replayPlans.push(replay);
            authorities.resourceContracts.push(resources);
            authorities.stateAccess.push(state);
            declaration.commandDigest = digestCanonical(command);
            declaration.replayPlanDigest = sha256(replay.bytes);
            const references = [['execution-envelope', declaration.executionEnvelopeDigest], ['replay-plan', declaration.replayPlanDigest], ['temporal-context', declaration.temporalContextDigest]].map(([kind, artifactDigest]) => ({
                kind, artifactPath: kind === 'replay-plan' ? replay.artifactPath : `${id}/${kind}.json`, artifactDigest,
                verificationReceiptPath: `${id}/${kind}-verification.json`, verificationReceiptDigest: digestCanonical([id, kind, 'verification-fixture'])
            }));
            producerContexts[id] = { cwd: root, env, timeoutMs: 5000, authorityReferences: references, verifyAuthority: verifyCompilerFixtureAuthority };
        }
        const summary = input.declarations.find((entry) => entry.kind === 'settled-join');
        nodes.push({ kind: 'logical-projection', producerId: summary.producerId, logicalParentId: input.lane,
            owner: 'fixture-projection-owner', projectionOwner: 'fixture-projection-owner', dependsOn: [], settledDependsOn: summary.settledDependsOn });
        tiers.push({ id: input.lane, executionMode: 'projection', commandKind: 'projection', executionOwner: 'fixture-projection-owner', projectFrom: executable.map((entry) => entry.producerId).sort() });
        if (input.releasePrerequisite)
        {
            nodes.push({ kind: 'logical-projection', producerId: 'backend-release-build-summary', logicalParentId: input.releasePrerequisite.logicalParentId,
                owner: 'fixture-projection-owner', projectionOwner: 'fixture-projection-owner', dependsOn: [], settledDependsOn: [input.releasePrerequisite.producerId] });
            tiers.push({ id: input.releasePrerequisite.logicalParentId, executionMode: 'projection', commandKind: 'projection', executionOwner: 'fixture-projection-owner', projectFrom: [input.releasePrerequisite.producerId] });
        }
    }
    const plans = inputs.map(createBackendAtomicPlan);
    fs.writeFileSync(configurationFile, JSON.stringify({ plans, evidenceRoot }));
    const matrix = { tiers, atomicProducerDeclarations: { schema: 'fsusblog.atomic-producer-declarations.v1', nodes } };
    authorities.matrixDigest = digestCanonical(matrix);
    return { input: { plans, expectedPlanDigests: Object.fromEntries(plans.map((plan) => [plan.lane, plan.contentDigest])), matrix, authorities, sourceRoot: root },
        options: { context: { evidenceRoot, schedulerRunId: fixtureIdentity.schedulerRunId, sourceCommit: fixtureIdentity.sourceCommit, worktreeFingerprint: fixtureIdentity.worktreeFingerprint },
            profile: fixtureIdentity.profile, producerContexts, verifyAuthority: verifyCompilerFixtureAuthority,
            capacity: { maxParallel: 3, cpuUnits: 3, memoryGiB: 3, stateConflictPolicy: {
                assertCurrent()
                {},
                evaluate()
                {
                    return { conflict: false, conflicts: [] };
                }
            } } } };
}
