import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const { bindDemoTemporalBusinessFields, prepareDemoTemporalBinding } = await import(new URL('../../tools/test-fixtures/producers/demo-temporal-binding.mjs', import.meta.url));
const { prepareDemoPublic } = await import(new URL('../../tools/test-fixtures/producers/demo-public-producer.mjs', import.meta.url));
const { bindDataScaleTemporalBusinessFields } = await import(new URL('../../tools/data-scale/temporal-business-binding.mjs', import.meta.url));
const { requireCompleteTemporalEntityBinding, verifyObservedTemporalEntityBusinessFields } = await import(new URL('../../tools/test-fixtures/temporal-business-fields.mjs', import.meta.url));
const { consumerContext, consumerEntityPlan, consumerInput } = await import(new URL('./support/temporal-entity-consumer-fixtures.mjs', import.meta.url));

function lookup(entityKind, semanticIdentity, operationIdentity = 'created')
{
    return { entityKind, semanticIdentity, operationIdentity };
}

function observations(binding)
{
    return binding.fields.map(({ coordinate, field, applicability, instantUtc }) => ({ coordinate, field, applicability, instantUtc }));
}

test('demo consumes distinct entity timestamps, explicit pending NULL and creation revisions', () =>
{
    const binding = bindDemoTemporalBusinessFields(consumerInput());
    const approved = binding.requireField(lookup('comment', 'approved'), 'comment.moderated-at');
    const pending = binding.requireField(lookup('comment', 'pending'), 'comment.moderated-at');
    assert.equal(approved.instantUtc, '2026-06-01T11:05:00.000Z');
    assert.equal(pending.applicability, 'null');
    assert.equal(pending.instantUtc, null);
    assert.equal(binding.requireField(lookup('comment', 'pending'), 'comment-revision.created-at').instantUtc, '2026-06-02T11:00:00.000Z');
    assert.notEqual(binding.requireField(lookup('audit', 'audit-security'), 'audit.occurred-at').instantUtc,
        binding.requireField(lookup('audit', 'audit-moderation'), 'audit.occurred-at').instantUtc);
    assert.equal(binding.unsupportedFields[0].field, 'profile.created-at');
    assert.throws(() => binding.requireField(lookup('profile', 'profile'), 'profile.created-at'), /unsupported/u);
    assert.throws(() => requireCompleteTemporalEntityBinding(binding), /unsupported fields remain OPEN/u);
    assert.equal(binding.qualificationEligible, false);
});

test('scale distinguishes an ungenerated revision row from a NULL published column', () =>
{
    const binding = bindDataScaleTemporalBusinessFields(consumerInput('scale-data'));
    const coordinate = lookup('article', 'control-scheduled');
    assert.equal(binding.requireField(coordinate, 'article-revision.created-at').applicability, 'not-generated');
    assert.equal(binding.requireField(coordinate, 'article-publication.published-at').applicability, 'not-generated');
    assert.equal(binding.requireField(coordinate, 'article.published-at').applicability, 'null');
    assert.equal(binding.requireField(coordinate, 'article.createtime').applicability, 'instant');
    assert.equal(binding.unsupportedFields[0].field, 'row.created-at');
    assert.throws(() => binding.requireField(coordinate, 'row.created-at'), /unsupported/u);
    assert.throws(() => binding.requireField(lookup('article', 'missing'), 'article.createtime'), /unbound/u);
});

test('rights snapshot retains the explicitly published revision across later entity history', () =>
{
    const plan = consumerEntityPlan();
    const later = structuredClone(plan.entities[0]);
    later.coordinate.operationIdentity = 'revision-2';
    later.coordinate.revisionNumber = 2;
    later.facts['article.revision'].instantUtc = '2026-06-03T10:00:00.000Z';
    later.facts['article.metadata-updated'].instantUtc = '2026-06-03T10:00:00.000Z';
    plan.entities.splice(1, 0, later);
    const binding = bindDemoTemporalBusinessFields(consumerInput('development-demo', plan));
    const coordinate = lookup('article', 'control-published', 'revision-2');
    assert.equal(binding.requireField(coordinate, 'article-revision.created-at').instantUtc, '2026-06-03T10:00:00.000Z');
    assert.equal(binding.requireField(coordinate, 'article-rights-snapshot.created-at').instantUtc, '2026-06-01T10:00:00.000Z');
});

test('entity consumption refuses changed held plans, artifact data and cross-producer identity', () =>
{
    const input = consumerInput();
    assert.throws(() => bindDemoTemporalBusinessFields({ ...input,
        expected: { ...input.expected, entityPlanDigest: `sha256:${'0'.repeat(64)}` } }), /held/u);
    const artifact = structuredClone(input.artifact);
    artifact.entities[2].roles[0].instantUtc = '2026-06-01T11:00:01.000Z';
    assert.throws(() => bindDemoTemporalBusinessFields({ ...input, artifact }), /differs from/u);
    assert.throws(() => bindDemoTemporalBusinessFields({ ...input,
        expected: { ...input.expected, namespace: 'foreign' } }), /held namespace/u);
    assert.throws(() => bindDataScaleTemporalBusinessFields(input), /scale-data context/u);
    const binding = bindDemoTemporalBusinessFields(input);
    input.artifact.entities[2].roles[0].instantUtc = 'tamper';
    assert.equal(binding.requireField(lookup('comment', 'approved'), 'comment.create-time').instantUtc, '2026-06-01T11:00:00.000Z');
    assert.equal(Object.isFrozen(binding.fields[0].coordinate), true);
});

test('observations retain complete coordinates and NULL versus ungenerated row distinctions', () =>
{
    const binding = bindDataScaleTemporalBusinessFields(consumerInput('scale-data'));
    const rows = observations(binding);
    assert.deepEqual(verifyObservedTemporalEntityBusinessFields(binding, rows),
        verifyObservedTemporalEntityBusinessFields(binding, [...rows].reverse()));
    assert.throws(() => verifyObservedTemporalEntityBusinessFields({ ...binding }, rows), /created by this consumer/u);
    assert.throws(() => verifyObservedTemporalEntityBusinessFields(binding, rows.slice(1)), /exact-match/u);
    assert.throws(() => verifyObservedTemporalEntityBusinessFields(binding, [rows[0], ...rows.slice(0, -1)]), /duplicate/u);
    for (const mutate of [
        (row) =>
        {
            row.coordinate.ordinal = 99;
        },
        (row) =>
        {
            row.instantUtc = '2026-06-01T09:00:01.000Z';
        },
        (row) =>
        {
            row.extra = true;
        }
    ])
    {
        const altered = structuredClone(rows);
        mutate(altered[0]);
        assert.throws(() => verifyObservedTemporalEntityBusinessFields(binding, altered), /timestamp or applicability/u);
    }
    const altered = structuredClone(rows);
    altered.find((row) => row.applicability === 'not-generated').applicability = 'null';
    assert.throws(() => verifyObservedTemporalEntityBusinessFields(binding, altered), /applicability/u);
});

test('original chronology contradictions pass unchanged to the authority and are refused', () =>
{
    const demo = consumerEntityPlan();
    Object.assign(demo.entities[0].facts, {
        'article.created': { applicability: 'instant', instantUtc: '2026-06-01T10:00:00.000Z' },
        'article.revision': { applicability: 'instant', instantUtc: '2026-06-01T10:05:00.000Z' }
    });
    const before = structuredClone(demo);
    assert.throws(() => prepareDemoTemporalBinding({ temporalContext: consumerContext(), namespace: 'ordinary',
        runIdentity: 'entity-consumer-control', plan: { variantPlanDigest: demo.sourcePlanDigest }, entityPlan: demo }), /cross-field invariant/u);
    assert.deepEqual(demo, before);
    const scale = consumerEntityPlan('scale-data');
    scale.entities[0].facts['article.revision'].instantUtc = '2026-06-04T00:00:00.000Z';
    scale.entities[0].facts['article.publication'].instantUtc = '2026-06-03T00:00:00.000Z';
    scale.entities[0].facts['article.published'].instantUtc = '2026-06-03T00:00:00.000Z';
    assert.throws(() => consumerInput('scale-data', scale), /cross-field invariant/u);
    const nested = consumerEntityPlan('scale-data');
    nested.entities[3].facts['comment.created'].instantUtc = '2026-06-01T10:59:59.000Z';
    nested.distribution.rootNested[1] = { commentIdentity: 'pending', parentIdentity: 'approved', rootIdentity: 'approved' };
    assert.throws(() => consumerInput('scale-data', nested), /cross-field invariant/u);
});

test('unsupported real source fields prevent sealed demo cleanup and HTTP writes', async () =>
{
    const entityPlan = consumerEntityPlan();
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = () =>
    {
        calls += 1;
        throw new Error('unexpected write');
    };
    try
    {
        await assert.rejects(prepareDemoPublic({ temporalContext: consumerContext(), namespace: 'ordinary',
            runIdentity: 'entity-consumer-control', entityPlan, plan: { variantPlanDigest: entityPlan.sourcePlanDigest },
            previousProducerReceipt: { deliberately: 'invalid' },
            handles: { baseUrl: 'http://127.0.0.1:7568', localDemoFixtureSecret: 'test-only' } }), /unsupported fields remain OPEN/u);
        assert.equal(calls, 0);
    }
    finally
    {
        globalThis.fetch = originalFetch;
    }
});

test('entity bindings repeat across process timezones with host clock reads forbidden', () =>
{
    const script = `
        Date.now = () => { throw new Error('host wall clock forbidden'); };
        const { consumerInput } = await import(${JSON.stringify(new URL('./support/temporal-entity-consumer-fixtures.mjs', import.meta.url).href)});
        const { bindDemoTemporalBusinessFields } = await import(${JSON.stringify(new URL('../../tools/test-fixtures/producers/demo-temporal-binding.mjs', import.meta.url).href)});
        process.stdout.write(bindDemoTemporalBusinessFields(consumerInput()).semanticDigest);
    `;
    const values = ['UTC', 'America/New_York', 'Asia/Tokyo'].map((TZ) =>
    {
        const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
            env: { ...process.env, TZ }, encoding: 'utf8' });
        assert.equal(child.status, 0, child.stderr);
        return child.stdout;
    });
    assert.equal(new Set(values).size, 1);
});
