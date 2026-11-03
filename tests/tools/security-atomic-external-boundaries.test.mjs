import assert from 'node:assert/strict';
import test from 'node:test';

const { collectSecurityTerminals } = await import(new URL('../../tools/test/security-atomic/contract.mjs', import.meta.url));
const {
    admitSecurityBoundary,
    projectSecurityBoundaries,
    securityBoundaryIds
} = await import(new URL('../../tools/test/security-atomic/external-boundaries.mjs', import.meta.url));

import { createSecurityAtomicFixture } from './support/security-atomic-fixtures.mjs';

function boundaryFixture()
{
    const fixture = createSecurityAtomicFixture();
    const selection = Object.fromEntries(securityBoundaryIds.map((producerId) => [producerId, {
        applicable: true,
        reasonCode: 'controlled-explicit-required-policy',
        classification: 'correctness',
        explicitInputs: [fixture.reference('boundaryInput', `${producerId}-input`)],
        envelope: fixture.reference('envelope', `${producerId}-envelope`),
        replay: fixture.reference('replay', `${producerId}-replay`),
        stateAccess: fixture.reference('stateAccess', `${producerId}-stateAccess`)
    }]));
    const policyReference = fixture.reference('boundaryPolicy', 'explicit-policy', { selection });
    return { ...fixture, policyReference, runtimeReference: fixture.references.runtime, selection };
}

test('closed policy projects all four external producers with catalog commands and exact settled membership', async () =>
{
    const fixture = boundaryFixture();
    const plan = await projectSecurityBoundaries(fixture);
    assert.deepEqual(plan.producers.map((producer) => producer.producerId), securityBoundaryIds);
    assert.deepEqual(plan.aggregate.settledDependsOn, securityBoundaryIds);
    assert.equal(plan.aggregate.executesCommands, false);
    assert.equal(plan.producers[3].invocation.scenario.command, 'npm run check:security:dast');
    assert.equal(plan.producers[0].invocation.scenario.id, 'security.local-runtime-exposure');
    assert.ok(plan.producers.every((producer) => producer.allowedRetries === 0 && producer.attemptNumber === 1));
});

test('applicable missing input is a failure and cannot become not-applicable', async () =>
{
    const fixture = boundaryFixture();
    const plan = fixture.register(await projectSecurityBoundaries(fixture));
    const producer = plan.producers[1];
    fixture.records.delete(producer.selection.explicitInputs[0].path);
    await assert.rejects(admitSecurityBoundary({ ...fixture, producer }), /boundaryInput owner rejected/u);
    assert.equal(producer.selection.applicable, true);
    const missingEvidence = boundaryFixture();
    missingEvidence.selection['security-firewall-evidence'].explicitInputs = [];
    missingEvidence.policyReference = missingEvidence.reference('boundaryPolicy', 'missing-firewall-input', { selection: missingEvidence.selection });
    await assert.rejects(projectSecurityBoundaries(missingEvidence), /requires explicit evidence/u);
});

test('not-applicable requests require verified policy, retain a terminal obligation and consume no runtime inputs', async () =>
{
    const fixture = boundaryFixture();
    fixture.selection['security-dast'].applicable = false;
    fixture.selection['security-dast'].reasonCode = 'controlled-policy-excluded';
    fixture.policyReference = fixture.reference('boundaryPolicy', 'excluded-dast', { selection: fixture.selection });
    const plan = fixture.register(await projectSecurityBoundaries(fixture));
    fixture.calls.length = 0;
    const request = await admitSecurityBoundary({ ...fixture, producer: plan.producers[3] });
    assert.equal(request.spawn, false);
    assert.equal(request.requiresTerminalReceipt, true);
    assert.deepEqual(fixture.calls, ['boundaryPolicy']);
    const tampered = structuredClone(plan.producers[0]);
    tampered.selection.applicable = false;
    await assert.rejects(admitSecurityBoundary({ ...fixture, producer: tampered }), /declaration drift/u);
});

test('local runtime failure does not prevent unrelated firewall admission and stale evidence is refused', async () =>
{
    const fixture = boundaryFixture();
    const plan = fixture.register(await projectSecurityBoundaries(fixture));
    fixture.records.get(fixture.runtimeReference.path).document.ready = false;
    await assert.rejects(admitSecurityBoundary({ ...fixture, producer: plan.producers[0] }), /runtime owner rejected/u);
    const admitted = await admitSecurityBoundary({ ...fixture, producer: plan.producers[1] });
    assert.equal(admitted.producerId, 'security-firewall-evidence');
    await assert.rejects(admitSecurityBoundary({ ...fixture, context: { ...fixture.context, runId: 'stale-run' }, producer: plan.producers[1] }), /rejected evidence/u);
});

test('state envelope replay and live-policy capabilities are required without ambient credential fallback', async () =>
{
    const fixture = boundaryFixture();
    const plan = fixture.register(await projectSecurityBoundaries(fixture));
    const ownerVerifiers = { ...fixture.ownerVerifiers, stateAccess: undefined };
    await assert.rejects(admitSecurityBoundary({ ...fixture, ownerVerifiers, producer: plan.producers[2] }), /missing canonical stateAccess/u);
    const missingPolicy = { ...fixture.ownerVerifiers, boundaryPolicy: undefined };
    await assert.rejects(projectSecurityBoundaries({ ...fixture, ownerVerifiers: missingPolicy }), /missing canonical boundaryPolicy/u);
});

test('policy roster drift and extra ambient fields fail closed', async () =>
{
    const fixture = boundaryFixture();
    fixture.selection['security-firewall-evidence'].ambientCredential = 'forbidden';
    fixture.policyReference = fixture.reference('boundaryPolicy', 'extra-ambient-field', { selection: fixture.selection });
    await assert.rejects(projectSecurityBoundaries(fixture), /requires exactly/u);
    delete fixture.selection['security-firewall-evidence'];
    fixture.policyReference = fixture.reference('boundaryPolicy', 'missing-boundary', { selection: fixture.selection });
    await assert.rejects(projectSecurityBoundaries(fixture), /boundary policy projection requires exactly/u);
});

test('DAST failure cannot be overwritten by warning success and every conditional result needs a terminal', async () =>
{
    const fixture = boundaryFixture();
    const references = securityBoundaryIds.map((id) => fixture.terminal(id,
        id === 'security-dast' ? 'failed' : 'success', id === 'security-dast' ? ['dast-failure'] : []));
    const summary = await collectSecurityTerminals({ ...fixture, producerIds: securityBoundaryIds, references });
    assert.equal(summary.status, 'failed');
    assert.deepEqual(summary.primaryFailureRefs, ['dast-failure']);
    await assert.rejects(collectSecurityTerminals({ ...fixture, producerIds: securityBoundaryIds, references: references.slice(0, 3) }), /exact-one terminal/u);
    const tampered = structuredClone(references);
    tampered[3].terminalState = 'success';
    tampered[3].reasonCode = 'job-warning';
    await assert.rejects(collectSecurityTerminals({ ...fixture, producerIds: securityBoundaryIds, references: tampered }), /fields must match/u);
});
