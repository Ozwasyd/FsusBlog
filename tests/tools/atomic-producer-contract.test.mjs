import assert from 'node:assert/strict';
import test from 'node:test';
import { URL } from 'node:url';

import { atomicFixture, atomicReference, rebindAtomicFixture } from './support/atomic-producer-fixture.mjs';

const { digestCanonical, sealContentDigest } = await import(new URL('../../tools/test/attempt-provenance.mjs', import.meta.url));
const { validateAtomicProducerDeclarations } = await import(new URL('../../tools/test-matrix/atomic-producers/contract.mjs', import.meta.url));
const { compositeObservationDigest, renderCompositeLeafDisposition, validateCompositeLeafDisposition } = await import(new URL('../../tools/test-matrix/atomic-producers/disposition.mjs', import.meta.url));

function validate(fixture)
{
    rebindAtomicFixture(fixture);
    return validateAtomicProducerDeclarations(fixture.matrix, fixture.authorities);
}

test('atomic contract validates closed versioned matrix attachment without mutating topology', () =>
{
    const fixture = atomicFixture();
    const before = structuredClone(fixture);
    const declarations = validateAtomicProducerDeclarations(fixture.matrix, fixture.authorities);
    assert.equal(declarations.nodes.length, 6);
    assert.deepEqual(fixture, before);
    declarations.nodes[0].owner = 'changed-owner';
    assert.deepEqual(fixture, before);
});

test('atomic contract rejects duplicate producer and missing or ambiguous physical owners', () =>
{
    const duplicate = atomicFixture();
    duplicate.matrix.atomicProducerDeclarations.nodes.push(structuredClone(duplicate.matrix.atomicProducerDeclarations.nodes[0]));
    assert.throws(() => validate(duplicate), /duplicate producerId/u);
    const missing = atomicFixture();
    missing.authorities.physicalOwnership.pop();
    assert.throws(() => validate(missing), /ownership roster/u);
    const ambiguous = atomicFixture();
    ambiguous.authorities.physicalOwnership[0].owner = 'another-owner';
    assert.throws(() => validate(ambiguous), /ambiguous physical ownership/u);
});

test('atomic contract rejects runtime unknown state and executable coordination resources', () =>
{
    const runtime = atomicFixture();
    runtime.matrix.atomicProducerDeclarations.nodes[0].executionClass = 'runtime';
    assert.throws(() => validate(runtime), /stateAccessRef/u);
    const resource = atomicFixture();
    resource.authorities.resourceContracts[0] = sealContentDigest({ id: 'isolated-static-resources', resources: { coordinationOnly: true } });
    resource.matrix.atomicProducerDeclarations.nodes.filter((node) => node.resourceContractRef).forEach((node) =>
    {
        node.resourceContractRef = atomicReference(resource.authorities.resourceContracts[0]);
    });
    assert.throws(() => validate(resource), /coordination-only/u);
});

test('atomic contract rejects missing correctness policy, retries and collect-inside-producer', () =>
{
    const missing = atomicFixture();
    delete missing.matrix.atomicProducerDeclarations.nodes[0].attemptPolicyId;
    assert.throws(() => validate(missing), /schema/u);
    const retry = atomicFixture();
    retry.matrix.atomicProducerDeclarations.nodes[0].attemptPolicyId = 'diagnostic-browser-process-crash';
    assert.throws(() => validate(retry), /schema/u);
    const hidden = atomicFixture();
    hidden.matrix.atomicProducerDeclarations.nodes[0].failurePolicy = 'collect-inside-producer';
    assert.throws(() => validate(hidden), /schema/u);
});

test('atomic contract rejects source closure drift even after material resealing', () =>
{
    const fixture = atomicFixture();
    fixture.authorities.inputClosures[0] = sealContentDigest({
        ...fixture.authorities.inputClosures[0],
        commandSourceId: 'foreign-command',
        contentDigest: undefined
    });
    fixture.authorities.commandSources[0] = sealContentDigest({
        ...fixture.authorities.commandSources[0],
        inputClosureRef: atomicReference(fixture.authorities.inputClosures[0]),
        contentDigest: undefined
    });
    const reference = atomicReference(fixture.authorities.commandSources[0]);
    fixture.matrix.atomicProducerDeclarations.nodes[0].commandSourceRef = reference;
    fixture.authorities.physicalOwnership[0].commandSourceRef = reference;
    assert.throws(() => validate(fixture), /input closure mismatch/u);
});

test('atomic contract rejects summary commands, cycles and finalizers that unlock work', () =>
{
    const summary = atomicFixture();
    summary.matrix.tiers[0].command = 'hidden-command';
    assert.throws(() => validate(summary), /command-free/u);
    const cycle = atomicFixture();
    cycle.matrix.atomicProducerDeclarations.nodes[0].dependsOn = ['dependent-check'];
    assert.throws(() => validate(cycle), /cycle/u);
    const successor = atomicFixture();
    successor.matrix.atomicProducerDeclarations.nodes[0].dependsOn = ['cleanup-inventory'];
    assert.throws(() => validate(successor), /cannot unlock/u);
    const command = atomicFixture();
    command.matrix.atomicProducerDeclarations.nodes[3].command = ['node', 'tests.mjs'];
    assert.throws(() => validate(command), /schema/u);
});

test('atomic contract rejects issue-prefixed identities and second topology fields', () =>
{
    const identity = atomicFixture();
    identity.matrix.atomicProducerDeclarations.nodes[0].producerId = 'issue-2247-alpha';
    assert.throws(() => validate(identity), /schema/u);
    const topology = atomicFixture();
    topology.matrix.atomicProducerDeclarations.physicalProducerCatalog = [];
    assert.throws(() => validate(topology), /schema/u);
});

test('logical projection identity is explicit and is not inferred from the parent name', () =>
{
    const fixture = atomicFixture();
    fixture.matrix.atomicProducerDeclarations.nodes.find((node) => node.kind === 'logical-projection').producerId = 'explicit-domain-summary';
    fixture.matrix.atomicProducerDeclarations.nodes.at(-1).settledDependsOn = ['alpha-check', 'beta-check', 'dependent-check', 'explicit-domain-summary', 'settled-observer'];
    assert.equal(validate(fixture).nodes.length, 6);
});

test('canonical replay plan digest cannot replace the independently bound artifact byte digest', () =>
{
    const fixture = atomicFixture();
    const reference = fixture.matrix.atomicProducerDeclarations.nodes[0].replayPlanRef;
    assert.notEqual(reference.contentDigest, reference.planDigest);
    reference.contentDigest = reference.planDigest;
    assert.throws(() => validate(fixture), /artifact byte digest mismatch/u);
});

function dispositionFixture()
{
    const observations = ['alpha-check', 'beta-check', 'workflow-check'].map((id) => ({
        location: id === 'workflow-check' ? '.github/workflows/quality-gate.yml:step:fixture' : `tools/test/lanes/fixture.sh:function:${id}`,
        parentId: 'fixture-parent',
        childCommandIdentity: id,
        commandSourceRef: { id: `${id}-source`, contentDigest: digestCanonical(id) },
        authorityKind: 'producer',
        proofTestIds: ['fixture-disposition-proof']
    }));
    const authorities = { matrixDigest: digestCanonical('isolated-matrix'), observations, migrationOwners: [2249, 2266] };
    const inventory = {
        schema: 'fsusblog.composite-leaf-disposition.v1',
        matrixDigest: authorities.matrixDigest,
        observationDigest: compositeObservationDigest(observations),
        entries: observations.map((entry) => ({
            location: entry.location,
            parentId: entry.parentId,
            childCommandIdentity: entry.childCommandIdentity,
            commandSourceRef: entry.commandSourceRef,
            currentBehavior: 'sequential fail-fast fixture command',
            classification: 'atomic-producer',
            migrationOwner: entry.childCommandIdentity === 'workflow-check' ? 2266 : 2249,
            proofTestId: 'fixture-disposition-proof',
            reason: 'owns an independent canonical command and result'
        }))
    };
    return { inventory, authorities };
}

test('disposition catches two hidden children and an omitted workflow command', () =>
{
    const hidden = dispositionFixture();
    hidden.inventory.entries.splice(0, 2);
    assert.throws(() => validateCompositeLeafDisposition(hidden.inventory, hidden.authorities), /hidden executable children/u);
    const workflow = dispositionFixture();
    workflow.inventory.entries.pop();
    assert.throws(() => validateCompositeLeafDisposition(workflow.inventory, workflow.authorities), /roster differs/u);
});

test('disposition rejects absent, multiple, tracking and unknown migration owners', () =>
{
    for (const value of [undefined, [2249, 2266], 2244, 999999])
    {
        const fixture = dispositionFixture();
        fixture.inventory.entries[0].migrationOwner = value;
        assert.throws(() => validateCompositeLeafDisposition(fixture.inventory, fixture.authorities), /schema|tracking child/u);
    }
    const injectedTracking = dispositionFixture();
    injectedTracking.authorities.migrationOwners = [2244];
    injectedTracking.inventory.entries.forEach((entry) =>
    {
        entry.migrationOwner = 2244;
    });
    assert.throws(() => validateCompositeLeafDisposition(injectedTracking.inventory, injectedTracking.authorities), /tracking child/u);
});

test('disposition rejects duplicate children, producer as join and unproved classification', () =>
{
    const duplicate = dispositionFixture();
    duplicate.inventory.entries.push(structuredClone(duplicate.inventory.entries[0]));
    assert.throws(() => validateCompositeLeafDisposition(duplicate.inventory, duplicate.authorities), /duplicate/u);
    const join = dispositionFixture();
    join.inventory.entries[0].classification = 'settled-join';
    assert.throws(() => validateCompositeLeafDisposition(join.inventory, join.authorities), /coordination-only/u);
    const proof = dispositionFixture();
    proof.inventory.entries[0].proofTestId = 'unowned-proof';
    assert.throws(() => validateCompositeLeafDisposition(proof.inventory, proof.authorities), /source-owner proof/u);
});

test('disposition audit digest and documentation are stable across observation and inventory order', () =>
{
    const fixture = dispositionFixture();
    const expected = validateCompositeLeafDisposition(fixture.inventory, fixture.authorities);
    const documentation = renderCompositeLeafDisposition(fixture.inventory, fixture.authorities);
    fixture.inventory.entries.reverse();
    fixture.authorities.observations.reverse();
    const actual = validateCompositeLeafDisposition(fixture.inventory, fixture.authorities);
    assert.equal(actual.contentDigest, expected.contentDigest);
    assert.equal(renderCompositeLeafDisposition(fixture.inventory, fixture.authorities), documentation);
    assert.equal(actual.entries.length, 3);
    fixture.inventory.activeTopology = [];
    assert.throws(() => validateCompositeLeafDisposition(fixture.inventory, fixture.authorities), /schema/u);
});
