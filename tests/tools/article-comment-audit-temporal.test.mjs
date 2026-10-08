import assert from 'node:assert/strict';
import test from 'node:test';

import { bindArticleCommentAuditTemporal, compareResolvedTemporalFields } from '../../tools/test-fixtures/producers/article-comment-audit-temporal.mjs';
import { defaultTimeoutPolicyDigest, qualificationTemporalContext } from '../../tools/test/temporal-context.mjs';
import { readTemporalDomainProducerInventory, resolveTemporalRolesForProducer } from '../../tools/test/temporal-role-resolver.mjs';

function context(producerId)
{
    return {
        runIdentity: 'temporal-domain-test',
        namespace: 'temporal_domain_test',
        temporalContext: qualificationTemporalContext({
            sourceCommit: 'a'.repeat(40),
            sourceFingerprint: `sha256:${'b'.repeat(64)}`,
            producerId,
            schedulerRunId: 'temporal-domain-test',
            businessEpochUtc: '2024-02-29T23:59:59.000Z',
            locale: 'en-US',
            uiLocale: 'en-US',
            timeoutPolicyDigest: defaultTimeoutPolicyDigest()
        })
    };
}

for (const producerId of ['public-content', 'comment-moderation', 'audit-records'])
{
    test(`${producerId} refuses the actual unbound upstream inventory`, () =>
    {
        assert.throws(() => bindArticleCommentAuditTemporal(context(producerId), producerId),
            (error) => error.reasonCode === 'temporal.producer-unbound');
    });
    test(`${producerId} refuses missing context and cross-run substitution`, () =>
    {
        assert.throws(() => bindArticleCommentAuditTemporal({}, producerId));
        assert.throws(() => bindArticleCommentAuditTemporal({ ...context(producerId), runIdentity: 'another-run' }, producerId));
    });
}

test('a bound auth shape cannot be borrowed by the article/comment/audit consumer', () =>
{
    assert.throws(() => bindArticleCommentAuditTemporal(context('auth-session'), 'public-content'));
    assert.throws(() => bindArticleCommentAuditTemporal(context('auth-session'), 'auth-session'));
});

function observedFields()
{
    // Exercise the neutral field comparator with a genuinely bound existing producer.
    // This does not make account-messaging an article/comment/audit producer authority.
    const temporalContext = context('account-messaging').temporalContext;
    const artifact = resolveTemporalRolesForProducer({
        temporalContext,
        namespace: 'temporal_domain_test', fixtureId: 'account-messaging',
        planDigest: `sha256:${'c'.repeat(64)}`
    });
    const mappings = readTemporalDomainProducerInventory().producerBindings
        .find((entry) => entry.producerId === 'account-messaging').fieldMappings;
    const roles = new Map(artifact.roles.map((role) => [role.roleId, role.instantUtc]));
    return { artifact, mappings, temporalContext, observation: {
        resolvedArtifactDigest: artifact.contentDigest,
        rows: mappings.map((mapping) => ({ entityId: 'observed-1', field: mapping.field,
            instantUtc: roles.get(mapping.roleId) }))
    } };
}

test('row order and generatedAt cannot change business timestamp digest', () =>
{
    const { artifact, mappings, observation, temporalContext } = observedFields();
    const first = compareResolvedTemporalFields(artifact, mappings, observation, temporalContext);
    const second = compareResolvedTemporalFields(artifact, mappings,
        { ...observation, generatedAt: 'metadata-only', rows: [...observation.rows].reverse() }, temporalContext);
    assert.deepEqual(first, second);
    assert.equal(Object.hasOwn(first, 'qualificationEligible'), false);
    assert.equal(first.observedFieldCount, mappings.length);
});

test('timestamp tamper, precision loss, field omission, duplicate and unknown fields fail', () =>
{
    const { artifact, mappings, observation, temporalContext } = observedFields();
    for (const rows of [
        observation.rows.slice(1),
        [...observation.rows, observation.rows[0]],
        [{ ...observation.rows[0], instantUtc: '2024-02-29T23:59:59.0000001Z' }, ...observation.rows.slice(1)],
        [{ ...observation.rows[0], field: 'unknown.business-timestamp' }, ...observation.rows.slice(1)],
        [{ ...observation.rows[0], hiddenTimestamp: 'unmapped' }, ...observation.rows.slice(1)]
    ])
    {
        assert.throws(() => compareResolvedTemporalFields(artifact, mappings, { ...observation, rows }, temporalContext));
    }
    assert.throws(() => compareResolvedTemporalFields(artifact, mappings,
        { ...observation, resolvedArtifactDigest: `sha256:${'e'.repeat(64)}` }, temporalContext));
});
