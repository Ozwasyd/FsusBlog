import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { URL } from 'node:url';

const { compileAtomicProducerDag } = await import(new URL('../../tools/test-matrix/atomic-producers/compiler.mjs', import.meta.url));
const { digestCanonical } = await import(new URL('../../tools/test/attempt-provenance.mjs', import.meta.url));
const { executeFrontendManifestAtomicGroup, prepareFrontendManifestAdmission } = await import(new URL('../../tools/test/frontend-atomic/manifest-admission.mjs', import.meta.url));
const { atomicExecutionOptions, atomicFixture, rebindAtomicFixture } = await import(new URL('./support/atomic-producer-fixture.mjs', import.meta.url));

/** Reuse the published canonical ordinary command fixture; never production evidence. */
function frontendFixture(t, scenarios = {})
{
    const fixture = atomicFixture(scenarios);
    const groupId = 'frontend-fixture';
    fixture.matrix.tiers[0].id = groupId;
    fixture.matrix.tiers[0].executionDependsOn = [];
    for (const node of fixture.matrix.atomicProducerDeclarations.nodes)
    {
        node.logicalParentId = groupId;
    }
    fixture.authorities.physicalOwnership.forEach((item) => item.logicalParentId = groupId);
    fixture.matrix.commandGroups = {
        [groupId]: {
            lane: groupId,
            schema: 'fsusblog.test-command-manifest.v1',
            commands: fixture.authorities.physicalOwnership.map((item) =>
            {
                const node = fixture.matrix.atomicProducerDeclarations.nodes.find((candidate) => candidate.producerId === item.producerId);
                const command = fixture.authorities.commandSources.find((source) => source.id === node.commandSourceRef.id).command;
                return { id: node.producerId, command, access: 'read', consumedInputs: [command[1]],
                    resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 },
                    dependsOn: node.dependsOn, settledDependsOn: node.settledDependsOn };
            })
        }
    };
    rebindAtomicFixture(fixture);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-frontend-admission-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const options = { ...atomicExecutionOptions(fixture, root), groupId };
    return { fixture, options, root, compile: () => compileAtomicProducerDag(fixture.matrix, fixture.authorities) };
}

test('frontend admission binds every manifest entry to the canonical graph without issuing authority', (t) =>
{
    const { options, compile } = frontendFixture(t);
    const compiled = compile();
    const prepared = prepareFrontendManifestAdmission(compiled, options);
    assert.equal(prepared.qualificationEligible, false);
    assert.equal(prepared.compiledDagDigest, compiled.contentDigest);
    assert.deepEqual(prepared.entryIds, ['alpha-check', 'beta-check', 'dependent-check']);
    assert.equal(Object.isFrozen(prepared.entryIds), true);
});

test('frontend admission requires explicit entry resource and input declarations before attempt creation', async (t) =>
{
    const { fixture, options, root, compile } = frontendFixture(t);
    delete fixture.matrix.commandGroups[options.groupId].commands[0].resources;
    rebindAtomicFixture(fixture);
    await assert.rejects(executeFrontendManifestAtomicGroup(compile(), options), /explicit entry resource/u);
    assert.deepEqual(fs.readdirSync(root), []);
});

test('frontend admission preserves declared exclusive and counted resources', (t) =>
{
    const { fixture, options, compile } = frontendFixture(t);
    const material = fixture.authorities.resourceContracts[0];
    const resources = { ...material.resources, exclusiveResources: ['frontend-fixture-output'], countedResources: { browser: 1 } };
    const body = { id: material.id, resources };
    const replacement = { ...body, contentDigest: digestCanonical(body) };
    fixture.authorities.resourceContracts[0] = replacement;
    for (const node of fixture.matrix.atomicProducerDeclarations.nodes.filter((item) => item.resourceContractRef))
    {
        node.resourceContractRef.contentDigest = replacement.contentDigest;
    }
    fixture.matrix.commandGroups[options.groupId].commands.forEach((entry) => entry.resources = structuredClone(resources));
    rebindAtomicFixture(fixture);
    const compiled = compile();
    const prepared = prepareFrontendManifestAdmission(compiled, options);
    assert.equal(prepared.compiledDagDigest, compiled.contentDigest);
    assert.deepEqual(compiled.steps.find((step) => step.id === 'alpha-check').resources, resources);
});

test('frontend manifest executes real canonical child attempts and retains independent failure and blocked vectors', async (t) =>
{
    const { options, compile, root } = frontendFixture(t, { alphaScenario: 'product-failure' });
    let vector;
    await assert.rejects(executeFrontendManifestAtomicGroup(compile(), options), (error) =>
    {
        vector = error.terminalVector;
        assert.ok(vector);
        return true;
    });
    const receipts = Object.fromEntries(vector.receipts.map((receipt) => [receipt.producerId, receipt]));
    assert.equal(vector.qualificationEligible, false);
    assert.equal(receipts['alpha-check'].terminalState, 'failed');
    assert.equal(receipts['beta-check'].terminalState, 'success');
    assert.equal(receipts['dependent-check'].terminalState, 'blocked');
    assert.equal(receipts['dependent-check'].attemptRef, null);
    assert.equal(receipts['fixture-summary'].terminalState, 'failed');
    for (const id of ['alpha-check', 'beta-check'])
    {
        const receipt = JSON.parse(fs.readFileSync(receipts[id].attemptRef.path, 'utf8'));
        assert.equal(receipt.attemptNumber, 1);
        assert.equal(receipt.maxAttempts, 1);
        assert.equal(receipt.retryPolicyId, 'correctness-first-attempt');
        assert.deepEqual(receipt.command, options.matrix.commandGroups[options.groupId].commands.find((entry) => entry.id === id).command);
        assert.equal(fs.existsSync(path.join(path.dirname(receipts[id].attemptRef.path), '../attempt-2')), false);
    }
    assert.equal(fs.existsSync(path.join(root, options.context.schedulerRunId, 'dependent-check')), false);
});

test('frontend canonical all-success group has one attempt per entry and a complete settled projection', async (t) =>
{
    const { options, compile } = frontendFixture(t);
    const vector = await executeFrontendManifestAtomicGroup(compile(), options);
    assert.equal(vector.status, 'success');
    assert.equal(vector.qualificationEligible, false);
    assert.ok(vector.receipts.every((receipt) => receipt.terminalState === 'success'));
    assert.equal(vector.receipts.filter((receipt) => receipt.attemptRef !== null).length, 3);
});

test('frontend replay environment must match the current entry context before any spawn', async (t) =>
{
    const { options, compile, root } = frontendFixture(t);
    options.producerContexts['alpha-check'].env = { ...options.producerContexts['alpha-check'].env, EXTRA_CONTEXT: 'different' };
    await assert.rejects(executeFrontendManifestAtomicGroup(compile(), options), /replay source\/run\/environment/u);
    assert.deepEqual(fs.readdirSync(root), []);
});
