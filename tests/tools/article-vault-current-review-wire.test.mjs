import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { decodeVaultCurrentReviewRequest, encodeVaultCurrentReviewRequest, validateVaultCurrentReviewRequest } from 'fsusblog-client/codecs/binary/article-vault-current-review-wire';

const literal = name => Uint8Array.from(Buffer.from(readFileSync(new URL(`../fixtures/article-vault-current-review-wire/${name}.hex`, import.meta.url), 'utf8').trim(), 'hex'));
const request = checkpoint => ({
    articleId: 1234567, resolutionOperationIdentity: `resolution-${'a'.repeat(64)}`, proposalSha256: 'b'.repeat(64),
    checkpoint: checkpoint ? { sequence: 2, contentSha256: '9'.repeat(64), operation: {
        schema: 'fsusblog.article-vault.operation-identity.v1', schemaVersion: 1,
        siteIdentity: 'site-中😀', vaultIdentity: 'vault-one', deviceIdentity: 'device-one', agentIdentity: 'agent-one', planReference: 'plan-one',
        planSha256: 'c'.repeat(64), requestSha256: 'd'.repeat(64), idempotencySha256: 'e'.repeat(64), deadlineUnixMs: 1700000000123,
        operationIdentity: 'f'.repeat(64), contentSha256: 'a'.repeat(64)
    } } : null
});

for (const [name, present] of [['proposal-only', false], ['exact-checkpoint', true]])
{
    test(`independent literal ${name}, immutable detached decode`, () =>
    {
        const bytes = literal(name);
        assert.deepEqual(encodeVaultCurrentReviewRequest(request(present)), bytes);
        const decoded = decodeVaultCurrentReviewRequest(bytes);
        bytes.fill(0);
        assert.deepEqual(decoded, request(present));
        assert.equal(Object.isFrozen(decoded), true);
        if (decoded.checkpoint !== null)
        {
            assert.equal(Object.isFrozen(decoded.checkpoint), true);
            assert.equal(Object.isFrozen(decoded.checkpoint.operation), true);
        }
    });
}

for (const [offset, replacement] of [[0, 0], [4, 2], [6, 2], [12, 1], [16, 0], [27, 65], [91, 1], [96, 65], [167, 255],
    [168, 65], [232, 0], [275, 1], [280, 2], [284, 1], [288, 32], [289, 192], [310, 1], [800, 47], [1312, 92], [1824, 9],
    [2848, 65], [2912, 65], [2976, 65], [3047, 255], [3048, 65], [3112, 65]])
{
    test(`closed field negative ${offset}/${replacement}`, () =>
    {
        const bytes = literal('exact-checkpoint');
        bytes[offset] = replacement;
        assert.throws(() => decodeVaultCurrentReviewRequest(bytes), /article_vault_current_review_request_invalid/u);
    });
}

test('exact size, absent data, zero article, unsafe integers, unsupported identity and unknown properties', () =>
{
    for (const size of [0, 3175, 3177])
    {
        assert.throws(() => decodeVaultCurrentReviewRequest(new Uint8Array(size)));
    }
    const absent = literal('proposal-only');
    absent[160] = 1;
    assert.throws(() => decodeVaultCurrentReviewRequest(absent));
    for (const offset of [160, 3040])
    {
        const bytes = literal('exact-checkpoint');
        new DataView(bytes.buffer).setBigInt64(offset, 9007199254740992n, true);
        assert.throws(() => decodeVaultCurrentReviewRequest(bytes));
    }
    const zero = literal('proposal-only');
    zero.fill(0, 8, 12);
    assert.throws(() => decodeVaultCurrentReviewRequest(zero));
    assert.equal(validateVaultCurrentReviewRequest({ ...request(false), fabricatedCurrentInputs: {} }), false);
    const extra = request(true);
    extra.checkpoint.operation.unknown = true;
    assert.equal(validateVaultCurrentReviewRequest(extra), false);
    const getter = request(false);
    Object.defineProperty(getter, 'articleId', { get: () =>
    {
        throw new Error('must not invoke getter');
    } });
    assert.equal(validateVaultCurrentReviewRequest(getter), false);
    const broken = request(true);
    broken.checkpoint.operation.siteIdentity = 'bad\ud800';
    assert.equal(validateVaultCurrentReviewRequest(broken), false);
    const max = request(true);
    max.checkpoint.operation.siteIdentity = '中'.repeat(128);
    assert.deepEqual(decodeVaultCurrentReviewRequest(encodeVaultCurrentReviewRequest(max)), max);
    max.checkpoint.operation.siteIdentity += '中';
    assert.equal(validateVaultCurrentReviewRequest(max), false);
});
