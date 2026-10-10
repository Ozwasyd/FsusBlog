import assert from 'node:assert/strict';
import test from 'node:test';
import { URL } from 'node:url';

import { testDigest, otherDigest } from './release-candidate-test-support.mjs';
import { gitFixture, sourcePolicy } from './repository-source-snapshot-test-support.mjs';

const { collectFixtureIdentity, verifyFixtureIdentity } = await import(new URL('../../tools/release-candidate/collect-fixture-identity.mjs', import.meta.url));
const { snapshotRepositorySourceIdentity } = await import(new URL('../../tools/test/repository-source-snapshot.mjs', import.meta.url));
const { plan } = await import(new URL('../../tools/test-fixtures/orchestrator.mjs', import.meta.url));
const { aggregateVerifiedFixtureReceipt, buildProducerReceipt, digestReceiptBody } = await import(new URL('../../tools/test-fixtures/receipt/index.mjs', import.meta.url));
const { readFixtureCatalogs, sealMatrixFixtureProfile, buildProducerFixtureVariantPlan } = await import(new URL('../../tools/testing/fixture-catalog.mjs', import.meta.url));

function fixtureInputs(t, profileId = 'none')
{
    const fixture = gitFixture(t);
    const sourceSnapshot = snapshotRepositorySourceIdentity(fixture.root, { sourcePolicy });
    const catalogs = readFixtureCatalogs();
    const sealed = sealMatrixFixtureProfile({ fixtureProfile: profileId, executionClass: 'runtime' }, catalogs).sealed;
    const planned = plan({ profileId, profileSource: 'matrix', executionClass: 'runtime', sealed },
        { runId: 'fixture-run', namespace: 'fixture-namespace', sourceIdentity: {
            commit: sourceSnapshot.commit, worktreeFingerprint: sourceSnapshot.snapshotDigest } }, { catalogs });
    const producerReceipts = planned.order.map((producerId) =>
    {
        const variants = planned.variantIds.filter((id) => catalogs.variant.variants.find((item) => item.id === id).ownerProducerId === producerId);
        const producerVariantPlan = buildProducerFixtureVariantPlan({ producerId, variantIds: variants,
            fixtureVariantIds: planned.variantIds, fixtureVariantPlanDigest: planned.variantPlanDigest, catalogs });
        const capabilities = planned.capabilities.filter((id) => catalogs.capability.capabilities.find((item) => item.id === id).ownerProducerId === producerId);
        return buildProducerReceipt({ producerId, runId: 'fixture-run', namespace: 'fixture-namespace',
            source: planned.executionIdentity.sourceIdentity, fixtureCatalogDigest: planned.catalogDigest, profileId,
            expandedCapabilityDigest: planned.expandedCapabilityDigest, fixtureVariantIds: planned.variantIds,
            variantPlanDigest: planned.variantPlanDigest, producerVariantPlanDigest: producerVariantPlan.producerVariantPlanDigest,
            producedVariantIds: variants, providedCapabilities: capabilities,
            postconditionObservations: capabilities.flatMap((id) => catalogs.capability.capabilities.find((item) => item.id === id)
                .postconditionIds.map((postconditionId) => ({ capabilityId: id, postconditionId, ok: true, detail: { unitContract: true } }))), catalogs });
    });
    const receipt = aggregateVerifiedFixtureReceipt({ plan: planned, producerReceipts, catalogs });
    return { plan: planned, receipt, sourceSnapshot, catalogs, expectedRunId: 'fixture-run', expectedNamespace: 'fixture-namespace',
        aliasIdentityDigest: testDigest, policyIdentityDigest: testDigest };
}

test('fixture identity consumes the actual sealed orchestrator and verified none receipt', (t) =>
{
    const inputs = fixtureInputs(t);
    const fragment = collectFixtureIdentity(inputs);
    assert.equal(fragment.schema, 'fsusblog.release-candidate-fixture-identity.v1');
    assert.equal(fragment.identity.profileIdentity.profileId, 'none');
    assert.equal(fragment.identity.fixtureReceiptDigest, inputs.receipt.receiptDigest);
    assert.equal(fragment.bindings.sourceCommit, inputs.sourceSnapshot.commit);
    assert.equal(fragment.bindings.worktreeFingerprint, inputs.sourceSnapshot.snapshotDigest);
    assert.equal(verifyFixtureIdentity(fragment, inputs), fragment);
    assert.deepEqual(fragment.warnings, []);
});

test('fixture identity validates nonempty producer DAG and rejects a resealed foreign producer source', (t) =>
{
    const inputs = fixtureInputs(t, 'public-minimal');
    const fragment = collectFixtureIdentity(inputs);
    assert.equal(fragment.identity.producerReceiptDigests.length, inputs.plan.order.length);
    assert.ok(inputs.plan.order.length > 0);
    const foreignReceipt = structuredClone(inputs.receipt);
    const producer = foreignReceipt.producerReceipts[0];
    producer.source.worktreeFingerprint = otherDigest;
    producer.producerReceiptDigest = digestReceiptBody(producer, 'producerReceiptDigest');
    foreignReceipt.orderedProducerReceiptDigests[0] = producer.producerReceiptDigest;
    foreignReceipt.receiptDigest = digestReceiptBody(foreignReceipt, 'receiptDigest');
    assert.throws(() => collectFixtureIdentity({ ...inputs, receipt: foreignReceipt }), /producer.*source/u);
});

test('fixture identity rejects partial unverified tampered and cross-run receipts', (t) =>
{
    const inputs = fixtureInputs(t);
    for (const patch of [{ terminalStatus: 'partial' }, { receiptDigest: otherDigest }])
    {
        assert.throws(() => collectFixtureIdentity({ ...inputs, receipt: { ...inputs.receipt, ...patch } }), /verified|digest mismatch/u);
    }
    const foreign = structuredClone(inputs.receipt);
    foreign.executionIdentity.runId = 'foreign-run';
    foreign.receiptDigest = digestReceiptBody(foreign, 'receiptDigest');
    assert.throws(() => collectFixtureIdentity({ ...inputs, receipt: foreign }), /execution identity mismatch/u);
    assert.throws(() => collectFixtureIdentity({ ...inputs, expectedNamespace: 'foreign' }), /plan.namespace/u);
});

test('fixture identity requires explicit sealed profile source execution class and upstream bindings', (t) =>
{
    const inputs = fixtureInputs(t);
    for (const profilePatch of [{ profileId: '' }, { profileSource: 'dev-cli' }, { sealed: null }, { executionClass: null }])
    {
        assert.throws(() => collectFixtureIdentity({ ...inputs, plan: { ...inputs.plan,
            profileIdentity: { ...inputs.plan.profileIdentity, ...profilePatch } } }), Error);
    }
    assert.throws(() => collectFixtureIdentity({ ...inputs, aliasIdentityDigest: null }), /explicit alias/u);
    assert.throws(() => collectFixtureIdentity({ ...inputs, policyIdentityDigest: null }), /explicit policy/u);
    assert.throws(() => collectFixtureIdentity({ ...inputs, catalogs: null }), /canonical catalogs/u);
});

test('fixture identity rejects catalog variant DAG producer and source drift', (t) =>
{
    const inputs = fixtureInputs(t);
    for (const patch of [{ catalogDigest: otherDigest }, { variantPlanDigest: otherDigest },
        { variantIds: ['orphan'] }, { producers: ['orphan'] }, { edges: [{ from: 'a', to: 'b' }] }, { order: ['orphan'] }])
    {
        assert.throws(() => collectFixtureIdentity({ ...inputs, plan: { ...inputs.plan, ...patch } }), Error);
    }
    const foreign = { ...inputs.plan, executionIdentity: { ...inputs.plan.executionIdentity,
        sourceIdentity: { ...inputs.plan.executionIdentity.sourceIdentity, worktreeFingerprint: otherDigest } } };
    assert.throws(() => collectFixtureIdentity({ ...inputs, plan: foreign }), /plan.sourceIdentity/u);
});

test('fixture identity treats environment defaults as irrelevant and detects fragment tamper', (t) =>
{
    const inputs = fixtureInputs(t);
    const first = collectFixtureIdentity(inputs);
    const original = process.env.FSUSBLOG_FIXTURE_PROFILE;
    process.env.FSUSBLOG_FIXTURE_PROFILE = 'acceptance-representative';
    try
    {
        assert.deepEqual(collectFixtureIdentity(inputs), first);
    }
    finally
    {
        if (original === undefined)
        {
            delete process.env.FSUSBLOG_FIXTURE_PROFILE;
        }
        else
        {
            process.env.FSUSBLOG_FIXTURE_PROFILE = original;
        }
    }
    assert.throws(() => verifyFixtureIdentity({ ...first, contentDigest: otherDigest }, inputs), /fragment content/u);
});
