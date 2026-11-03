import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { URL } from 'node:url';

import { atomicExecutionOptions, atomicFixture, atomicReference } from './support/atomic-producer-fixture.mjs';
import { createSecurityAtomicFixture } from './support/security-atomic-fixtures.mjs';

const { projectSecurityScenarios } = await import(new URL('../../tools/test/security-atomic/scenarios.mjs', import.meta.url));
const { projectSecurityBoundaries, securityBoundaryIds } = await import(new URL('../../tools/test/security-atomic/external-boundaries.mjs', import.meta.url));
const { runSecurityBoundaryAttempt, runSecurityScenarioAttempt } = await import(new URL('../../tools/test/security-atomic/execution.mjs', import.meta.url));
const { compileAtomicProducerDag } = await import(new URL('../../tools/test-matrix/atomic-producers/compiler.mjs', import.meta.url));
const { digestCanonical, sealContentDigest, sha256 } = await import(new URL('../../tools/test/attempt-provenance.mjs', import.meta.url));
const { canonicalTestId, planExactShards, sealReplayPlan } = await import(new URL('../../tools/test/execution-replay-contract.mjs', import.meta.url));
const { acquireSchedulerRunLock, schedulerCandidateIdentityDigest } = await import(new URL('../../tools/test-matrix/scheduler-run-owner.mjs', import.meta.url));
const { writeCanonicalSchedulerFixture } = await import(new URL('./support/canonical-scheduler-fixture.mjs', import.meta.url));

async function scenarioExecutionFixture(evidenceRoot, outcome, t, { boundary = false } = {})
{
    const fixture = createSecurityAtomicFixture();
    let projection;
    if (boundary)
    {
        const selection = Object.fromEntries(securityBoundaryIds.map((id) => [id, {
            applicable: true, reasonCode: 'controlled-explicit-policy', classification: 'correctness',
            explicitInputs: [fixture.reference('boundaryInput', `${id}-input`)],
            envelope: fixture.reference('envelope', `${id}-envelope`),
            replay: fixture.reference('replay', `${id}-replay`),
            stateAccess: fixture.reference('stateAccess', `${id}-state`)
        }]));
        const policyReference = fixture.reference('boundaryPolicy', 'independent-boundary-policy', { selection });
        projection = fixture.register(await projectSecurityBoundaries({ ...fixture, policyReference }));
    }
    else
    {
        projection = fixture.register(projectSecurityScenarios({ ...fixture, mode: 'resident' }));
    }
    const producer = boundary ? projection.producers.find((item) => item.producerId === 'security-firewall-evidence')
        : projection.producers[0];
    const template = atomicFixture();
    const physical = [...producer.dependsOn, producer.producerId].sort();
    const profile = sealContentDigest({ id: fixture.context.profileId, fixtureKind: 'test-only' });
    const resource = template.authorities.resourceContracts[0];
    const authorities = { physicalOwnership: [], commandSources: [], inputClosures: [],
        fixtureProfiles: [profile], replayPlans: [], resourceContracts: [resource], stateAccess: [],
        finalizerOperations: template.authorities.finalizerOperations };
    const source = { commit: fixture.context.sourceRevision, worktreeFingerprint: `sha256:${'c'.repeat(64)}` };
    const startedMarker = path.join(evidenceRoot, 'scenario-started');
    const nodes = physical.map((id) =>
    {
        const testId = canonicalTestId({ framework: 'node-test', source: 'tests/tools/security-atomic-execution.test.mjs', name: ['ordinary-transport-control', id] });
        const command = [...template.authorities.commandSources[0].command];
        command[2] = id === producer.producerId ? outcome === 'cancelled' ? 'marker-wait' : outcome : 'success';
        command[3] = testId;
        if (command[2] === 'marker-wait')
        {
            command.push(startedMarker);
        }
        const closure = sealContentDigest({ id: `${id}-inputs`, commandSourceId: `${id}-command`,
            commandDigest: digestCanonical(command), unresolvedDynamicReads: [] });
        const commandSource = sealContentDigest({ id: `${id}-command`, command, executableAuthorityCount: 1,
            inputClosureRef: atomicReference(closure) });
        const { planDigest, ...unsigned } = template.authorities.replayPlans[0].plan;
        assert.ok(planDigest);
        const plan = sealReplayPlan({ ...unsigned, source, producer: { id, framework: 'node-test' },
            run: { id: fixture.context.runId, mode: 'diagnostic' },
            ...planExactShards({ testIds: [testId], shardCount: 1 }),
            command: { executable: command[0], args: command.slice(1), environmentDigest: digestCanonical({ PATH: process.env.PATH }) } });
        const replay = { id: `${id}-replay`, replayOwner: 'isolated-replay-owner', fixtureProfileDigest: profile.contentDigest,
            artifactPath: `${id}.replay-plan.json`, bytes: `${JSON.stringify(plan, null, 4)}\n`, plan };
        const state = sealContentDigest({ id: `${id}-state`, producerId: id, unknownAccess: false });
        const node = { ...template.matrix.atomicProducerDeclarations.nodes[0], producerId: id,
            logicalParentId: 'isolated-security-summary', executionClass: 'runtime',
            dependsOn: id === producer.producerId ? [...producer.dependsOn].sort() : [],
            commandSourceRef: atomicReference(commandSource), fixtureProfile: atomicReference(profile),
            stateAccessRef: atomicReference(state), resourceContractRef: atomicReference(resource),
            replayPlanRef: { id: replay.id, contentDigest: sha256(replay.bytes), planDigest: plan.planDigest } };
        authorities.commandSources.push(commandSource);
        authorities.inputClosures.push(closure);
        authorities.replayPlans.push(replay);
        authorities.stateAccess.push(state);
        authorities.physicalOwnership.push({ producerId: id, logicalParentId: node.logicalParentId,
            owner: node.owner, commandSourceRef: node.commandSourceRef });
        return node;
    });
    const matrix = { tiers: [{ id: 'isolated-security-summary', executionMode: 'projection', commandKind: 'projection',
        executionOwner: 'isolated-projection-owner', projectFrom: physical }],
    atomicProducerDeclarations: { schema: 'fsusblog.atomic-producer-declarations.v1', nodes: [...nodes,
        { kind: 'logical-projection', producerId: 'isolated-security-summary', logicalParentId: 'isolated-security-summary',
            owner: 'isolated-projection-owner', projectionOwner: 'isolated-projection-owner', dependsOn: [], settledDependsOn: physical }] } };
    authorities.matrixDigest = digestCanonical(matrix);
    const options = atomicExecutionOptions({ matrix, authorities }, evidenceRoot);
    // Existing helper verifies its fixed control identity; bind this control to
    // the selected security run without changing any canonical authority code.
    const producerContext = options.producerContexts[producer.producerId];
    const executionContext = { evidenceRoot, schedulerRunId: fixture.context.runId,
        sourceCommit: source.commit, worktreeFingerprint: source.worktreeFingerprint };
    producerContext.verifyAuthority = (reference) => ({ verified: true,
        authorityDigest: reference.artifactDigest, verificationReceiptDigest: reference.verificationReceiptDigest,
        identity: { sourceCommit: source.commit, schedulerRunId: fixture.context.runId,
            producerId: producer.producerId, worktreeFingerprint: source.worktreeFingerprint } });
    fixture.ownerVerifiers.scenarioExecution = (declared, step) =>
        declared.producerId === step.id ? declared.producerId : null;
    const runsRoot = path.join(evidenceRoot, 'canonical-runs');
    const checkpointFile = path.join(runsRoot, fixture.context.runId, 'checkpoint.json');
    const sourceState = { commit: source.commit, worktreeFingerprint: source.worktreeFingerprint.slice(7) };
    const candidateIdentityDigest = schedulerCandidateIdentityDigest({ runId: fixture.context.runId,
        targetTierId: producer.producerId, namespace: 'test-matrix', sourceState });
    const owner = acquireSchedulerRunLock({ runsRoot, runId: fixture.context.runId,
        targetTierId: producer.producerId, candidateIdentityDigest });
    owner.markRunning();
    t.after(() => owner.finalize('failed'));
    const grantDocument = { schema: 'fsusblog.test-matrix.resource-grants.v1', runId: fixture.context.runId,
        sourceState, schedulerOwnerToken: owner.owner.ownerToken, generation: 1, schedulerCheckpointRevision: 1,
        resourceBudget: { cpuUnits: 2, memoryGiB: 2 }, residentReservation: { cpuUnits: 0, memoryGiB: 0 },
        grants: { [producer.producerId]: { cpuUnits: 1, memoryGiB: 1 } }, generatedAt: new Date().toISOString() };
    writeCanonicalSchedulerFixture(checkpointFile, { runId: fixture.context.runId, sourceState,
        targetTierId: producer.producerId, schedulerCandidateIdentityDigest: candidateIdentityDigest,
        schedulerRunOwnerToken: owner.owner.ownerToken, authoritative: false, tiers: {},
        resourceUtilization: { resourceGrants: grantDocument } });
    fs.writeFileSync(path.join(path.dirname(checkpointFile), 'resource-grants.json'), JSON.stringify(grantDocument));
    const schedulerGrant = { checkpointFile, tierId: producer.producerId, ownerToken: owner.owner.ownerToken,
        minimumGeneration: 1, expectedGeneration: 1 };
    fixture.ownerVerifiers.scenarioGrantIdentity = (declared, step, grant) =>
        declared.producerId === step.id && grant.tierId === declared.producerId ? grant.tierId : null;
    fixture.ownerVerifiers.boundaryExecution = fixture.ownerVerifiers.scenarioExecution;
    fixture.ownerVerifiers.boundaryGrantIdentity = fixture.ownerVerifiers.scenarioGrantIdentity;
    return { ...fixture, producer, matrix, authorities, compiled: compileAtomicProducerDag(matrix, authorities),
        executionContext, producerContext, schedulerGrant, startedMarker, runtimeReference: fixture.references.runtime };
}

async function exerciseScenarioAttempt(outcome, t)
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'security-scenario-attempt-'));
    const fixture = await scenarioExecutionFixture(directory, outcome, t);
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const controller = new AbortController();
    fixture.producerContext.signal = controller.signal;
    const observed = runSecurityScenarioAttempt(fixture);
    if (outcome === 'cancelled')
    {
        const deadline = Date.now() + 3000;
        try
        {
            while (!fs.existsSync(fixture.startedMarker) && Date.now() < deadline)
            {
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            assert.ok(fs.existsSync(fixture.startedMarker), 'actual owned scenario child started');
        }
        finally
        {
            controller.abort(new Error('owned security scenario cancelled'));
        }
    }
    const result = await observed;
    assert.equal(result.attempts.length, 1);
    const attempt = result.attempts[0];
    assert.equal(attempt.attemptNumber, 1);
    assert.equal(attempt.maxAttempts, 1);
    assert.equal(attempt.producerId, fixture.producer.producerId);
    assert.equal(attempt.replayPlanDigest, fixture.compiled.steps.find((step) => step.id === fixture.producer.producerId).replayPlanRef.contentDigest);
    assert.equal(attempt.failureKind, outcome === 'success' ? null
        : outcome === 'cancelled' ? 'runner-cancelled' : 'assertion-mismatch');
    assert.equal(result.aggregate.cleanFirstAttempt, outcome === 'success');
    assert.ok(attempt.artifactPaths.includes(outcome === 'cancelled' ? 'stderr.log' : 'payload.json'));
    assert.equal(fs.existsSync(path.join(result.producerRoot, 'attempt-2')), false);
    assert.ok(fixture.calls.includes('runtime') && fixture.calls.includes('reset') && fixture.calls.includes('host'));
}

test('security scenario canonical attempt records original success once with replay and artifacts',
    (t) => exerciseScenarioAttempt('success', t));

test('security scenario canonical attempt records original product-failure once with replay and artifacts',
    (t) => exerciseScenarioAttempt('product-failure', t));

test('security scenario canonical attempt records original cancelled once with replay and artifacts',
    (t) => exerciseScenarioAttempt('cancelled', t));

test('firewall boundary consumes explicit evidence and writes its independent canonical first attempt', async (t) =>
{
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'security-boundary-attempt-'));
    const fixture = await scenarioExecutionFixture(directory, 'success', t, { boundary: true });
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const result = await runSecurityBoundaryAttempt(fixture);
    assert.equal(result.attempt.attempts.length, 1);
    assert.equal(result.attempt.attempts[0].producerId, 'security-firewall-evidence');
    assert.equal(result.attempt.aggregate.cleanFirstAttempt, true);
    assert.equal(result.qualificationEligible, false);
    assert.ok(fixture.calls.includes('boundaryPolicy') && fixture.calls.includes('boundaryInput'));
    assert.equal(fixture.calls.includes('host'), false);
});
