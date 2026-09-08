import assert from 'node:assert/strict';
import test from 'node:test';

import { digestCanonical, freezeDeep } from '../../tools/test-fixtures/receipt/canonical.mjs';
import { verifySealedDocument } from '../../tools/test-runtime/contract.mjs';
import { composeRuntimeOrderIdentity } from '../../tools/test-runtime/runtime-order-identity.mjs';

const digest = value => digestCanonical({ value });

function authority()
{
    const fixedClock = { epochMs: 1_700_000_000_000, digest: digestCanonical({
        schema: 'fsusblog.runtime-order-fixed-clock.v1', epochMs: 1_700_000_000_000
    }) };
    return composeRuntimeOrderIdentity({
        runId: 'runtime-order-current',
        attemptId: 'attempt-0001',
        sourceState: { commit: 'a'.repeat(40), worktreeFingerprint: digest('source') },
        fixedClock,
        buildReceipt: { file: '.tmp/build/receipt.json', contentDigest: digest('build'), fileDigest: digest('build-file') },
        replayQualification: { file: '.tmp/replay/receipt.json', contentDigest: digest('replay'), fileDigest: digest('replay-file') },
        fixtureAuthorities: [{ file: 'config/testing/fixture-profile-catalog.json', digest: digest('fixture-file') }],
        executionEnvelopePolicy: { file: 'config/testing/test-execution-envelope-policy.json', digest: digest('envelope-file') },
        catalogDigest: digest('catalog')
    });
}

test('canonical runtime-order identity binds source and every immutable schedule input', () =>
{
    const value = authority();
    assert.equal(verifySealedDocument(value), value);
    assert.equal(value.schema, 'fsusblog.production-runtime-order-identity.v1');
    assert.equal(value.identity.sessionId, 'schedule-template');
    assert.equal(value.identity.sourceCommit, 'a'.repeat(40));
    assert.equal(value.identity.buildReceiptDigest, value.buildReceipt.contentDigest);
    assert.equal(value.identity.replayDigest, value.replayQualification.contentDigest);
    assert.equal(value.identity.clockDigest, value.fixedClock.digest);
    assert.equal(value.identity.fixtureDigest, digestCanonical({
        schema: 'fsusblog.runtime-order-fixture-authorities.v1', files: value.fixtureAuthorities
    }));
});

test('runtime-order identity rejects an incomplete or non-canonical source identity', () =>
{
    const value = authority();
    assert.throws(() => composeRuntimeOrderIdentity({
        runId: value.identity.runId,
        attemptId: value.identity.attemptId,
        sourceState: { commit: 'short', worktreeFingerprint: value.identity.sourceFingerprint },
        fixedClock: value.fixedClock,
        buildReceipt: value.buildReceipt,
        replayQualification: value.replayQualification,
        fixtureAuthorities: value.fixtureAuthorities,
        executionEnvelopePolicy: value.executionEnvelopePolicy,
        catalogDigest: value.identity.catalogDigest
    }), /sourceCommit/u);
});

test('runtime-order authority bindings compare canonically after sealed key sorting', () =>
{
    const liveBinding = {
        file: 'config/testing/fixture-profile-catalog.json',
        digest: digest('fixture-file')
    };
    const sealedBinding = freezeDeep(liveBinding);

    assert.notEqual(JSON.stringify(liveBinding), JSON.stringify(sealedBinding));
    assert.equal(digestCanonical(liveBinding), digestCanonical(sealedBinding));
});
