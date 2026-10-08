import assert from 'node:assert/strict';
import test from 'node:test';

import { bindArticleCommentAuditTemporal } from '../../tools/test-fixtures/producers/article-comment-audit-temporal.mjs';
import { defaultTimeoutPolicyDigest, qualificationTemporalContext } from '../../tools/test/temporal-context.mjs';

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
